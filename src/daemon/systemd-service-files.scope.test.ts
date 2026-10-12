import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ExecResult } from "./exec-file.js";
import type { SystemdServiceReadTarget } from "./service-types.js";

const systemBus = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execBusctlSystem>());
const userBus = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execBusctlUser>());
const findScope = vi.hoisted(() => vi.fn());
vi.mock("./systemd-exec.js", async (original) => ({
  ...(await original<typeof import("./systemd-exec.js")>()),
  execBusctlSystem: systemBus,
  execBusctlUser: userBus,
}));
vi.mock("./systemd-scope.js", () => ({ findInstalledSystemdGatewayScope: findScope }));

import {
  readSystemdServiceCommandLocation,
  readSystemdServiceExecStart,
  readSystemdServiceExecStartAsRoot,
} from "./systemd-service-files.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const env = { HOME: "/home/caller", OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway" };
let target: SystemdServiceReadTarget;
let serviceUser: string;
let managerUid: number;
let assignments: string[];
let unset: string[];
let managerChanges: boolean;
let ownerReads: number;
let fileSpecs: [string, boolean][];
let loaded: boolean;
let loadState: string;
let unitFileState: string;
let activeState: string;
let canStart: boolean;
let refuseManualStart: boolean;
let emptyCommand: boolean;

const success = (stdout: string): ExecResult => ({
  code: 0,
  termination: "exit",
  stdout,
  stderr: "",
});
const property = (type: string, data: unknown) => ({ type, data });

beforeEach(async () => {
  const home = dirs.make("openclaw-system-scope-");
  target = {
    scope: "system",
    unitName: "openclaw.service",
    unitPath: path.join(home, "openclaw.service"),
  };
  await fs.writeFile(target.unitPath, "[Service]\nExecStart=/local/stale gateway\n");
  findScope.mockReset().mockResolvedValue(target);
  userBus.mockReset().mockRejectedValue(new Error("wrong user manager"));
  serviceUser = "gateway";
  managerUid = 0;
  assignments = ["OPENCLAW_SERVICE_KIND=gateway"];
  unset = [];
  managerChanges = false;
  ownerReads = 0;
  fileSpecs = [];
  loaded = true;
  loadState = "loaded";
  unitFileState = "enabled";
  activeState = "active";
  canStart = true;
  refuseManualStart = false;
  emptyCommand = false;
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "gateway",
    uid: 2001,
    gid: 2001,
    homedir: "/home/gateway",
    shell: "/bin/sh",
  });
  systemBus.mockReset().mockImplementation(async (args) => {
    if (args.includes("GetNameOwner")) {
      return success(
        JSON.stringify(property("s", [managerChanges && ++ownerReads > 1 ? ":1.99" : ":1.42"])),
      );
    }
    if (args.includes("GetConnectionUnixUser")) {
      return success(JSON.stringify(property("u", [managerUid])));
    }
    if (args.includes("GetUnitFileState")) {
      return success(JSON.stringify(property("s", [unitFileState])));
    }
    if (args.includes("GetUnit") || args.includes("LoadUnit")) {
      expect(args.at(-1)).toBe(target.unitName);
      if (!loaded) {
        return {
          code: 1,
          termination: "exit",
          stdout: "",
          stderr: `Call failed: Unit ${target.unitName} not loaded.`,
        };
      }
      return success(
        JSON.stringify(property("o", ["/org/freedesktop/systemd1/unit/openclaw_2eservice"])),
      );
    }
    const properties: Record<string, unknown> = {
      FragmentPath: property("s", target.unitPath),
      DropInPaths: property("as", []),
      NeedDaemonReload: property("b", false),
      LoadState: property("s", loadState),
      UnitFileState: property("s", unitFileState),
      ActiveState: property("s", activeState),
      CanStart: property("b", canStart),
      RefuseManualStart: property("b", refuseManualStart),
      ExecStart: property(
        "a(sasbttttuii)",
        emptyCommand
          ? []
          : [["/usr/bin/openclaw", ["/usr/bin/openclaw", "gateway"], false, 0, 0, 0, 0, 0, 0, 0]],
      ),
      WorkingDirectory: property("s", "/home/gateway"),
      Environment: property("as", assignments),
      EnvironmentFiles: property("a(sb)", fileSpecs),
      UnsetEnvironment: property("as", unset),
      User: property("s", serviceUser),
    };
    const index = args.findIndex((arg) => /\.(Unit|Service)$/.test(arg));
    if (index < 0) {
      throw new Error("unexpected system manager query");
    }
    expect(args).toContain(":1.42");
    return success(
      args
        .slice(index + 1)
        .map((name) => JSON.stringify(properties[name]))
        .join("\n"),
    );
  });
});
afterEach(() => vi.restoreAllMocks());

describe("system-scope effective command", () => {
  it.each([
    { canStart: false, refuse: false, empty: true, reason: "disabled-no-start" },
    { canStart: true, refuse: true, empty: true, reason: "refuse-manual-start" },
    { canStart: true, refuse: false, empty: false, reason: undefined },
    { canStart: true, refuse: true, empty: false, reason: undefined },
    { canStart: true, refuse: false, empty: false, reason: undefined, file: "masked-runtime" },
  ])(
    "preserves start policy when command inspection fails ($reason, refuse=$refuse)",
    async (row) => {
      unitFileState = row.file ?? "disabled";
      activeState = "inactive";
      canStart = row.canStart;
      refuseManualStart = row.refuse;
      emptyCommand = row.empty;
      const command = readSystemdServiceExecStart(env, {
        requireEffective: true,
        requireLoaded: true,
        systemdReadTarget: target,
      });
      if (row.reason) {
        await expect(command).rejects.toMatchObject({
          name: "ServiceStartRefusalError",
          refusal: { reason: row.reason },
        });
      } else {
        // Refusing manual start must not prevent inspection for an explicit stop.
        await expect(command).resolves.toMatchObject({
          programArguments: ["/usr/bin/openclaw", "gateway"],
        });
      }
      expect(systemBus.mock.calls.some(([args]) => args.includes("LoadUnit"))).toBe(false);
    },
  );

  it.each(["masked", "masked-runtime"])(
    "retains %s refusal before command inspection",
    async (state) => {
      loadState = "masked";
      unitFileState = state;
      loaded = state === "masked";
      await expect(
        readSystemdServiceExecStart(env, {
          requireEffective: true,
          requireLoaded: true,
          systemdReadTarget: target,
        }),
      ).rejects.toMatchObject({
        name: "ServiceStartRefusalError",
        message: expect.stringContaining(`sudo systemctl --system unmask ${target.unitName}`),
      });
      expect(systemBus.mock.calls.some(([args]) => args.includes("LoadUnit"))).toBe(false);
    },
  );

  it("lets root inspect an explicitly selected nonroot account with effective environment files", async () => {
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    const environmentFile = path.join(path.dirname(target.unitPath), "gateway.env");
    await fs.writeFile(environmentFile, "OPENCLAW_STATE_DIR=/var/lib/example\n");
    fileSpecs = [[environmentFile, false]];
    vi.spyOn(os, "userInfo").mockReturnValue({
      username: "root",
      uid: 0,
      gid: 0,
      homedir: "/root",
      shell: "/bin/sh",
    });

    await expect(readSystemdServiceExecStartAsRoot(env, target, "gateway")).resolves.toMatchObject({
      environment: { OPENCLAW_STATE_DIR: "/var/lib/example", OPENCLAW_SERVICE_KIND: "gateway" },
    });
    expect(systemBus.mock.calls.some(([args]) => args.includes("LoadUnit"))).toBe(false);
    await expect(readSystemdServiceExecStartAsRoot(env, target, "other")).rejects.toMatchObject({
      reason: "systemd-account-refused",
    });
  });

  it("refuses cross-account inspection before manager reads without root", async () => {
    vi.spyOn(process, "geteuid").mockReturnValue(2001);
    await expect(readSystemdServiceExecStartAsRoot(env, target, "gateway")).rejects.toMatchObject({
      reason: "systemd-account-refused",
    });
    expect(systemBus).not.toHaveBeenCalled();
  });

  it.each(["gateway", "other"])(
    "reads %s's location without accessing protected credentials",
    async (user) => {
      serviceUser = user;
      const protectedFile = path.join(path.dirname(target.unitPath), "protected-service.env");
      fileSpecs = [[protectedFile, false]];
      const readFile = fs.readFile;
      const reads = vi.spyOn(fs, "readFile").mockImplementation(async (file, ...args) => {
        if (file === protectedFile) {
          throw Object.assign(new Error("protected fixture"), { code: "EACCES" });
        }
        return readFile(file, ...args);
      });
      await expect(readSystemdServiceCommandLocation(env, target)).resolves.toEqual({
        kind: "command",
        command: {
          programArguments: ["/usr/bin/openclaw", "gateway"],
          workingDirectory: "/home/gateway",
          sourcePath: target.unitPath,
        },
      });
      expect(reads.mock.calls.some(([file]) => file === protectedFile)).toBe(false);
      expect(
        systemBus.mock.calls.some(
          ([args]) =>
            args.includes("Environment") ||
            args.includes("EnvironmentFiles") ||
            args.includes("User") ||
            args.includes("LoadUnit"),
        ),
      ).toBe(false);
      await expect(
        readSystemdServiceExecStart(env, {
          requireEffective: true,
          requireLoaded: true,
          systemdReadTarget: target,
        }),
      ).rejects.toMatchObject(
        user === "gateway" ? { code: "EACCES" } : { reason: "systemd-account-refused" },
      );
      if (user === "other") {
        expect(reads.mock.calls.some(([file]) => file === protectedFile)).toBe(false);
      }
    },
  );

  it("distinguishes an unloaded runtime from an absent installed service", async () => {
    loaded = false;
    await expect(readSystemdServiceCommandLocation(env, target)).resolves.toEqual({
      kind: "not-loaded",
    });
    await expect(
      readSystemdServiceExecStart(env, {
        requireEffective: true,
        requireLoaded: true,
        systemdReadTarget: target,
      }),
    ).rejects.toThrow("Effective systemd service command");
    expect(systemBus.mock.calls.some(([args]) => args.includes("LoadUnit"))).toBe(false);
  });

  it("does not turn unavailable native metadata into an unloaded runtime", async () => {
    systemBus.mockResolvedValue({
      code: 1,
      termination: "exit",
      stdout: "",
      stderr: "native metadata unavailable",
    });
    await expect(readSystemdServiceCommandLocation(env, target)).rejects.toThrow();
  });
  it.each([false, true])(
    "reads the selected system unit with discovered target=%s",
    async (discover) => {
      const command = await readSystemdServiceExecStart(env, {
        requireEffective: true,
        requireLoaded: true,
        ...(discover ? {} : { systemdReadTarget: target }),
      });
      expect(command).toMatchObject({
        programArguments: ["/usr/bin/openclaw", "gateway"],
        sourcePath: target.unitPath,
        environment: { HOME: "/home/gateway", OPENCLAW_SERVICE_KIND: "gateway" },
      });
      expect(command?.managedDefinition).toBeUndefined();
      expect(userBus).not.toHaveBeenCalled();
      expect(
        systemBus.mock.calls.every(
          ([args]) => args.includes("--auto-start=no") && !args.includes("LoadUnit"),
        ),
      ).toBe(true);
    },
  );

  it.each(["2001", "other"])(
    "requires the service account for strict inspection: %s",
    async (user) => {
      serviceUser = user;
      const command = readSystemdServiceExecStart(env, { requireEffective: true });
      if (user === "2001") {
        await expect(command).resolves.toMatchObject({ environment: { HOME: "/home/gateway" } });
      } else {
        await expect(command).rejects.toMatchObject({
          reason: "systemd-account-refused",
          message: expect.stringContaining("run Doctor as the service's User= account"),
        });
        await expect(readSystemdServiceExecStart(env)).resolves.toMatchObject({
          sourcePath: target.unitPath,
        });
      }
    },
  );

  it.each(["uid", "replacement"])("rejects an unverified system manager: %s", async (fault) => {
    managerUid = fault === "uid" ? 2001 : 0;
    managerChanges = fault === "replacement";
    await expect(
      readSystemdServiceExecStart(env, { requireEffective: true }),
    ).rejects.toMatchObject({
      reason: "systemd-manager-changed",
    });
  });

  it.each(["HOME", "HOME=/home/gateway"])(
    "honors explicit HOME removal: %s",
    async (assignment) => {
      unset = [assignment];
      const command = await readSystemdServiceExecStart(env, { requireEffective: true });
      expect(command?.environment).not.toHaveProperty("HOME");
    },
  );
});
