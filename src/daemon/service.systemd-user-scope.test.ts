import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import type { ExecResult } from "./exec-file.js";
import { systemdManagerVersionProbe } from "./systemd-user-bus.test-support.js";

const native = vi.hoisted(() => ({
  broker: vi.fn<typeof import("./systemd-peer-native.js").openSystemdBroker>(),
  peer: vi.fn<typeof import("./systemd-peer-native.js").openSystemdPrivatePeer>(),
}));
const exec = vi.hoisted(() => vi.fn<typeof import("./exec-file.js").execFileUtf8>());
vi.mock("./exec-file.js", () => ({ execFileUtf8: exec }));
vi.mock("./inspect.js", () => ({ findSystemGatewayServices: async () => [] }));
vi.mock("../shared/pid-alive.js", async (original) => ({
  ...(await original<typeof import("../shared/pid-alive.js")>()),
  getProcessStartTime: () => 100,
  isPidAlive: () => true,
}));
vi.mock("../infra/update-managed-service-handoff-lease.js", () => ({
  createManagedHandoffLeaseStore: () => ({ assertSourceUnborrowed: () => {} }),
}));
vi.mock("./systemd-system.js", async (original) => ({
  ...(await original<typeof import("./systemd-system.js")>()),
  assertNoSystemSystemdOwnership: async () => {},
}));
vi.mock("./systemd-peer-native.js", () => ({
  openSystemdBroker: native.broker,
  openSystemdPrivatePeer: native.peer,
}));

import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import { readGatewayServiceState, resolveGatewayService } from "./service.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const success = (stdout: string): ExecResult => ({
  code: 0,
  termination: "exit",
  stdout,
  stderr: "",
});

it("keeps strict legacy-user inspection on one admitted unit until its operation closes", async () => {
  mockProcessPlatform("linux");
  const uid = process.geteuid?.() || 1000;
  vi.spyOn(process, "geteuid").mockReturnValue(uid);
  const root = await fs.realpath(dirs.make("openclaw-user-read-"));
  const home = path.join(root, "home");
  const control = path.join(root, "control");
  const unitName = "openclaw-lisa.service";
  const unitPath = path.join(home, ".config/systemd/user", unitName);
  const canonicalPath = path.join(path.dirname(unitPath), "openclaw-gateway-lisa.service");
  const env = {
    HOME: home,
    OPENCLAW_PROFILE: "lisa",
    OPENCLAW_STATE_DIR: path.join(home, ".openclaw-lisa"),
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/bus`,
  };
  await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
  await fs.mkdir(control, { mode: 0o700 });
  await fs.mkdir(env.OPENCLAW_STATE_DIR, { mode: 0o700 });
  const programArguments = ["/usr/bin/node", "/opt/openclaw/openclaw.mjs", "gateway"];
  const unitSource = `[Service]\nExecStart=${programArguments.join(" ")}\nEnvironment=HOME=${home}\nEnvironment=OPENCLAW_PROFILE=lisa\n`;
  await fs.writeFile(unitPath, unitSource, { mode: 0o644 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  const access = fs.access.bind(fs);
  vi.spyOn(fs, "access").mockImplementation(async (...args) => {
    if (
      ["/etc/systemd/system/", "/usr/lib/systemd/system/", "/lib/systemd/system/"].some((prefix) =>
        String(args[0]).startsWith(prefix),
      )
    ) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return access(...args);
  });
  exec.mockImplementation(async (command, args) => {
    if (command === "systemctl") {
      return success(args.includes("is-enabled") ? "enabled\n" : "");
    }
    return await systemdManagerVersionProbe(command, args);
  });
  const close = vi.fn(async () => {});
  const brokerQuery = vi.fn(async (args: string[]) => [
    [args[4] === "GetNameOwner" ? ":1.0" : args[4] === "GetConnectionUnixUser" ? uid : 1234],
  ]);
  native.broker.mockResolvedValue({ query: brokerQuery, close: async () => {}, verify: () => {} });
  const properties: Record<string, unknown> = {
    FragmentPath: unitPath,
    DropInPaths: [],
    NeedDaemonReload: false,
    LoadState: "loaded",
    ExecStart: [[programArguments[0], programArguments, false, 0, 0, 0, 0, 0, 0, 0]],
    WorkingDirectory: "",
    Environment: [`HOME=${home}`, "OPENCLAW_PROFILE=lisa"],
    EnvironmentFiles: [],
    UnsetEnvironment: [],
    Id: unitName,
    ActiveState: "active",
    SubState: "running",
    StartLimitBurst: 5,
    ActiveEnterTimestampMonotonic: 100,
    InactiveEnterTimestampMonotonic: 0,
    Result: "success",
    NRestarts: 0,
    MainPID: 5678,
    ExecMainStatus: 0,
    ExecMainCode: 0,
    KillMode: "control-group",
    TasksCurrent: 1,
    MemoryCurrent: 1024,
    ControlGroup: `/user.slice/${unitName}`,
  };
  const query = vi.fn(async (args: string[]) => {
    if (args[0] === "call" && args[4] === "GetUnit") {
      return [["/org/freedesktop/systemd1/unit/legacy"]];
    }
    if (args[0] === "get-property") {
      return args.slice(4).map((name) => properties[name]);
    }
    throw new Error(`Unexpected native query: ${args.join(" ")}`);
  });
  native.peer.mockResolvedValue({ query, close, verify: () => {} });

  await withEnvAsync({ ...env, SUDO_USER: undefined }, async () => {
    const service = resolveGatewayService();
    await withGatewayServiceOperationLock(env, async () => {
      const read = () =>
        readGatewayServiceState(service, {
          env,
          requireEffective: true,
          requireLoadedCommand: true,
        });
      for (let readIndex = 0; readIndex < 2; readIndex++) {
        const state = await read();
        expect(state).toMatchObject({
          installed: true,
          running: true,
          command: {
            sourcePath: unitPath,
            programArguments,
            managedDefinition: { programArguments },
          },
          runtime: { systemd: { unit: unitName, managerUid: uid } },
        });
        expect(state.env.OPENCLAW_SYSTEMD_UNIT).toBeUndefined();
        expect(close).not.toHaveBeenCalled();
      }
      await fs.writeFile(canonicalPath, unitSource, { mode: 0o644 });
      await expect(read()).rejects.toMatchObject({ reason: "systemd-manager-changed" });
      expect(native.peer).toHaveBeenCalledOnce();
      expect(query.mock.calls.some(([args]) => args.includes("LoadUnit"))).toBe(false);
      expect(
        query.mock.calls
          .filter(([args]) => args[4] === "GetUnit")
          .every(([args]) => args[6] === unitName),
      ).toBe(true);
    });
  });
  expect(close).toHaveBeenCalledOnce();
});
