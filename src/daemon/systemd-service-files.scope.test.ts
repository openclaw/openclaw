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

import { readSystemdServiceExecStart } from "./systemd-service-files.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const env = { HOME: "/home/caller", OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway" };
let target: SystemdServiceReadTarget;
let serviceUser: string;
let managerUid: number;
let assignments: string[];
let unset: string[];
let managerChanges: boolean;
let ownerReads: number;

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
    if (args.includes("GetUnit") || args.includes("LoadUnit")) {
      expect(args.at(-1)).toBe(target.unitName);
      return success(
        JSON.stringify(property("o", ["/org/freedesktop/systemd1/unit/openclaw_2eservice"])),
      );
    }
    const properties: Record<string, unknown> = {
      FragmentPath: property("s", target.unitPath),
      DropInPaths: property("as", []),
      NeedDaemonReload: property("b", false),
      LoadState: property("s", "loaded"),
      ExecStart: property("a(sasbttttuii)", [
        ["/usr/bin/openclaw", ["/usr/bin/openclaw", "gateway"], false, 0, 0, 0, 0, 0, 0, 0],
      ]),
      WorkingDirectory: property("s", "/home/gateway"),
      Environment: property("as", assignments),
      EnvironmentFiles: property("a(sb)", []),
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
