import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "../cli/update-cli/update-command-service-maintenance.js";
import { withEnvAsync } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import type { ExecResult } from "./exec-file.js";
import type { SystemdServiceReadTarget } from "./service-types.js";

const exec = vi.hoisted(() => vi.fn<typeof import("./exec-file.js").execFileUtf8>());
const discovery = vi.hoisted(() => vi.fn<() => Promise<SystemdServiceReadTarget>>());
vi.mock("./exec-file.js", () => ({ execFileUtf8: exec }));
vi.mock("./systemd-scope.js", async (original) => ({
  ...(await original<typeof import("./systemd-scope.js")>()),
  findInstalledSystemdGatewayScope: discovery,
  findSystemdGatewayInstallation: async () => ({ kind: "system", system: await discovery() }),
  isSystemdServiceAbsent: async () => false,
}));

import { readGatewayServiceState, resolveGatewayService } from "./service.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const property = (type: string, data: unknown) => ({ type, data });
const success = (stdout: string): ExecResult => ({
  code: 0,
  termination: "exit",
  stdout,
  stderr: "",
});

it("admits offline maintenance through the registered system-scope reader and preserves its sealed definition", async () => {
  const home = await fs.realpath(dirs.make("openclaw-system-maintenance-"));
  const root = path.join(home, "package");
  const entrypoint = path.join(root, "openclaw.mjs");
  const target: SystemdServiceReadTarget = {
    scope: "system",
    unitName: "openclaw.service",
    unitPath: path.join(home, "openclaw.service"),
  };
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
  );
  await fs.writeFile(entrypoint, "");
  await fs.writeFile(
    target.unitPath,
    `[Service]\nUser=gateway\nExecStart=${process.execPath} ${entrypoint} gateway\n`,
  );
  discovery.mockResolvedValue(target);
  mockProcessPlatform("linux");
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "gateway",
    uid: 2001,
    gid: 2001,
    homedir: home,
    shell: "/bin/sh",
  });
  const properties: Record<string, unknown> = {
    UnitPath: property("as", [home]),
    FragmentPath: property("s", target.unitPath),
    DropInPaths: property("as", []),
    NeedDaemonReload: property("b", false),
    ExecStart: property("a(sasbttttuii)", [
      [process.execPath, [process.execPath, entrypoint, "gateway"], false, 0, 0, 0, 0, 0, 0, 0],
    ]),
    WorkingDirectory: property("s", home),
    Environment: property("as", []),
    EnvironmentFiles: property("a(sb)", []),
    UnsetEnvironment: property("as", []),
    User: property("s", "gateway"),
    Id: property("s", target.unitName),
    LoadState: property("s", "loaded"),
    ActiveState: property("s", "inactive"),
    SubState: property("s", "dead"),
    StartLimitBurst: property("u", 5),
    ActiveEnterTimestampMonotonic: property("t", 100),
    InactiveEnterTimestampMonotonic: property("t", 200),
    Result: property("s", "success"),
    NRestarts: property("u", 0),
    MainPID: property("u", 0),
    ExecMainStatus: property("i", 0),
    ExecMainCode: property("i", 1),
    KillMode: property("s", "control-group"),
    TasksCurrent: property("t", 0),
    MemoryCurrent: property("t", 0),
  };
  exec.mockReset().mockImplementation(async (command, args) => {
    if (command === "systemctl" && args[0] === "is-enabled") {
      return success("enabled\n");
    }
    if (command !== "busctl" || !args.includes("--system")) {
      return { ...success(""), code: 1, stderr: "User manager unavailable" };
    }
    if (args.includes("GetNameOwner")) {
      return success(JSON.stringify(property("s", [":1.42"])));
    }
    if (args.includes("GetConnectionUnixUser")) {
      return success(JSON.stringify(property("u", [0])));
    }
    if (args.includes("GetUnit")) {
      if (args.at(-1) !== target.unitName) {
        return { ...success(""), code: 1, stderr: `Call failed: Unit ${args.at(-1)} not loaded.` };
      }
      return success(
        JSON.stringify(property("o", ["/org/freedesktop/systemd1/unit/openclaw_2eservice"])),
      );
    }
    const index = args.findIndex((arg) => /\.(Unit|Service|Manager)$/.test(arg));
    if (index < 0) {
      throw new Error("Unexpected native command during read-only maintenance inspection");
    }
    return success(
      args
        .slice(index + 1)
        .map((name) => JSON.stringify(properties[name]))
        .join("\n"),
    );
  });
  await withEnvAsync(
    {
      HOME: home,
      USERPROFILE: undefined,
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_SYSTEMD_UNIT: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_SERVICE_MARKER: undefined,
      OPENCLAW_SERVICE_KIND: undefined,
    },
    async () => {
      const state = await readGatewayServiceState(resolveGatewayService(), {
        requireEffective: true,
        requireLoadedCommand: true,
      });
      expect(state).toMatchObject({
        systemdInstallation: { kind: "system", system: target },
        installed: true,
        running: false,
        loadState: { status: "loaded" },
        runtime: {
          status: "stopped",
          systemd: { scope: "system", unit: target.unitName, managerUid: 0 },
        },
        definitionMutationCapability: { kind: "sealed", reason: "system-owned" },
      });
      const admitted = await maybeStopManagedServiceBeforeMutableUpdate({
        root,
        updateInstallKind: "package",
        shouldRestart: true,
        phase: "inspect",
        jsonMode: true,
      });
      expect(admitted).toMatchObject({
        inspected: true,
        runtimeInspected: true,
        running: false,
        offline: true,
        serviceManagerUid: 0,
        serviceUpdateVerdict: { kind: "owned", refreshDefinition: false },
      });
      expect(admitted.blockMessage).toBeUndefined();
    },
  );
  expect(
    exec.mock.calls.every(([command, args]) =>
      command === "systemctl"
        ? args[0] === "is-enabled"
        : args.includes("--system") &&
          args.includes("--auto-start=no") &&
          !args.some((arg) => /^(Load|Start|Stop|Restart|Enable)Unit$/.test(arg)),
    ),
  ).toBe(true);
});
