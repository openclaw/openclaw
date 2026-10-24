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

import { nativeExit } from "./systemd-exec.test-support.js";
import {
  readSystemdServiceCommandLocation,
  readSystemdServiceExecStart,
  readSystemdServiceExecStartAsRoot,
} from "./systemd-service-files.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const env = { HOME: "/home/caller", OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway" };
let target: SystemdServiceReadTarget;
let ownerReads: number;
const defaults = {
  serviceUser: "gateway",
  managerUid: 0,
  assignments: ["OPENCLAW_SERVICE_KIND=gateway"],
  unset: [] as string[],
  managerChanges: false,
  fileSpecs: [] as [string, boolean][],
  loaded: true,
  loadState: "loaded",
  unitFileState: "enabled",
  activeState: "active",
  canStart: true,
  refuseManualStart: false,
  emptyCommand: false,
};
let state = { ...defaults };

const success = (stdout: string): ExecResult => nativeExit(stdout);
const property = (type: string, data: unknown) => ({ type, data });
const reply = (type: string, data: unknown) => success(JSON.stringify(property(type, data)));
const readLoaded = () =>
  readSystemdServiceExecStart(env, {
    requireEffective: true,
    requireLoaded: true,
    systemdReadTarget: target,
  });
const expectNoLoad = () =>
  expect(systemBus.mock.calls.some(([args]) => args.includes("LoadUnit"))).toBe(false);
const account = (username: string, uid: number) => ({
  username,
  uid,
  gid: uid,
  homedir: uid === 0 ? "/root" : `/home/${username}`,
  shell: "/bin/sh",
});

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
  state = { ...defaults };
  ownerReads = 0;
  vi.spyOn(os, "userInfo").mockReturnValue(account("gateway", 2001));
  systemBus.mockReset().mockImplementation(async (args) => {
    if (args.includes("GetNameOwner")) {
      return reply("s", [state.managerChanges && ++ownerReads > 1 ? ":1.99" : ":1.42"]);
    }
    if (args.includes("GetConnectionUnixUser")) {
      return reply("u", [state.managerUid]);
    }
    if (args.includes("GetUnitFileState")) {
      return reply("s", [state.unitFileState]);
    }
    if (args.includes("GetUnit") || args.includes("LoadUnit")) {
      expect(args.at(-1)).toBe(target.unitName);
      if (!state.loaded) {
        return nativeExit("", `Call failed: Unit ${target.unitName} not loaded.`, 1);
      }
      return reply("o", ["/org/freedesktop/systemd1/unit/openclaw_2eservice"]);
    }
    const properties: Record<string, unknown> = {
      FragmentPath: property("s", target.unitPath),
      DropInPaths: property("as", []),
      NeedDaemonReload: property("b", false),
      LoadState: property("s", state.loadState),
      UnitFileState: property("s", state.unitFileState),
      ActiveState: property("s", state.activeState),
      CanStart: property("b", state.canStart),
      RefuseManualStart: property("b", state.refuseManualStart),
      ExecStart: property(
        "a(sasbttttuii)",
        state.emptyCommand
          ? []
          : [["/usr/bin/openclaw", ["/usr/bin/openclaw", "gateway"], false, 0, 0, 0, 0, 0, 0, 0]],
      ),
      WorkingDirectory: property("s", "/home/gateway"),
      Environment: property("as", state.assignments),
      EnvironmentFiles: property("a(sb)", state.fileSpecs),
      UnsetEnvironment: property("as", state.unset),
      User: property("s", state.serviceUser),
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
      Object.assign(state, {
        unitFileState: row.file ?? "disabled",
        activeState: "inactive",
        canStart: row.canStart,
        refuseManualStart: row.refuse,
        emptyCommand: row.empty,
      });
      const command = readLoaded();
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
      expectNoLoad();
    },
  );

  it.each(["masked", "masked-runtime"])(
    "retains %s refusal before command inspection",
    async (unitFileState) => {
      Object.assign(state, {
        loadState: "masked",
        unitFileState,
        loaded: unitFileState === "masked",
      });
      await expect(readLoaded()).rejects.toMatchObject({
        name: "ServiceStartRefusalError",
        message: expect.stringContaining(`sudo systemctl --system unmask ${target.unitName}`),
      });
      expectNoLoad();
    },
  );

  it("lets root inspect an explicitly selected nonroot account with effective environment files", async () => {
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    const environmentFile = path.join(path.dirname(target.unitPath), "gateway.env");
    await fs.writeFile(environmentFile, "OPENCLAW_STATE_DIR=/var/lib/example\n");
    state.fileSpecs = [[environmentFile, false]];
    vi.spyOn(os, "userInfo").mockReturnValue(account("root", 0));

    await expect(readSystemdServiceExecStartAsRoot(env, target, "gateway")).resolves.toMatchObject({
      environment: { OPENCLAW_STATE_DIR: "/var/lib/example", OPENCLAW_SERVICE_KIND: "gateway" },
    });
    expectNoLoad();
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
      state.serviceUser = user;
      const protectedFile = path.join(path.dirname(target.unitPath), "protected-service.env");
      state.fileSpecs = [[protectedFile, false]];
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
      await expect(readLoaded()).rejects.toMatchObject(
        user === "gateway" ? { code: "EACCES" } : { reason: "systemd-account-refused" },
      );
      if (user === "other") {
        expect(reads.mock.calls.some(([file]) => file === protectedFile)).toBe(false);
      }
    },
  );

  it("distinguishes an unloaded runtime from an absent installed service", async () => {
    state.loaded = false;
    await expect(readSystemdServiceCommandLocation(env, target)).resolves.toEqual({
      kind: "not-loaded",
    });
    await expect(readLoaded()).rejects.toThrow("Effective systemd service command");
    expectNoLoad();
  });

  it("does not turn unavailable native metadata into an unloaded runtime", async () => {
    systemBus.mockResolvedValue(nativeExit("", "native metadata unavailable", 1));
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
      state.serviceUser = user;
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
    state.managerUid = fault === "uid" ? 2001 : 0;
    state.managerChanges = fault === "replacement";
    await expect(
      readSystemdServiceExecStart(env, { requireEffective: true }),
    ).rejects.toMatchObject({
      reason: "systemd-manager-changed",
    });
  });

  it.each(["HOME", "HOME=/home/gateway"])(
    "honors explicit HOME removal: %s",
    async (assignment) => {
      state.unset = [assignment];
      const command = await readSystemdServiceExecStart(env, { requireEffective: true });
      expect(command?.environment).not.toHaveProperty("HOME");
    },
  );
});
