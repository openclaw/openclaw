import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { execFileUtf8 } from "./exec-file.js";
import { mergeGatewayServiceEnv } from "./service-env-merge.js";
import { ServiceOwnershipRefusalError } from "./service-inspection-error.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { execBusctlUser as busctl, execSystemctlUser as systemctl } from "./systemd-exec.js";
import { openSystemdUserManager } from "./systemd-peer-native.js";
import {
  readSystemdServiceExecStart as readCommand,
  resolveSystemdUnitPath,
} from "./systemd-service-files.js";
import {
  readSystemdUserTransport as readTransport,
  resolveSystemdUserTransport as resolveTransport,
} from "./systemd-user-transport.js";

vi.mock("./exec-file.js", () => ({ execFileUtf8: vi.fn() }));
vi.mock("./systemd-peer-native.js", () => ({ openSystemdUserManager: vi.fn() }));
const exec = vi.mocked(execFileUtf8);
const open = vi.mocked(openSystemdUserManager);
const dirs = useAutoCleanupTempDirTracker(afterEach);
const success = (stdout: string) => ({ code: 0, termination: "exit" as const, stdout, stderr: "" });
const busError = "Failed to connect to bus: No such file or directory";
const missing = { ...success(""), code: 1, stderr: busError };
const version = 's "252.39"';
const unavailable = { reason: "systemd-user-bus-unavailable" };
function transportEnv(home: string, bus = "bus", runtime = home): GatewayServiceEnv {
  const DBUS_SESSION_BUS_ADDRESS = `unix:path=${home}/${bus}`;
  return { HOME: home, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS };
}
async function privateSocket(home: string) {
  await fs.mkdir(path.join(home, "systemd"), { recursive: true });
  await fs.writeFile(path.join(home, "systemd/private"), "");
}
function connection(close = vi.fn(async () => {})) {
  return { close, verify: () => {}, query: async () => ["252.39"] };
}
let home: string;
let env: GatewayServiceEnv;

function readService(sourceEnv: GatewayServiceEnv) {
  const unitPath = resolveSystemdUnitPath(sourceEnv);
  const target = { scope: "user" as const, unitName: "openclaw-gateway.service", unitPath };
  return readCommand(sourceEnv, { requireEffective: true, systemdReadTarget: target });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockProcessPlatform("linux");
  vi.spyOn(process, "geteuid").mockReturnValue(1000);
  home = dirs.make("openclaw-transport-");
  env = transportEnv(home);
});
afterEach(() => vi.restoreAllMocks());

it.each(["custom", "private", "unavailable"] as const)("shares %s transport", async (scenario) => {
  const runtimeDir = path.join(home, "runtime");
  await fs.mkdir(path.join(runtimeDir, "systemd"), { recursive: true });
  await fs.writeFile(path.join(runtimeDir, "bus"), "unrelated socket marker");
  if (scenario === "private") {
    await fs.writeFile(path.join(runtimeDir, "systemd/private"), "");
  }
  const custom = `unix:path=${home}/custom-bus`;
  env = transportEnv(home, "custom-bus", runtimeDir);
  Object.assign(env, { USER: "service", LOGNAME: "service", SUDO_USER: undefined });
  const selected = scenario === "custom" ? custom : undefined;
  const probes: string[] = [];
  const children: [string, string | undefined, string | undefined][] = [];
  exec.mockImplementation(async (command, args, options) => {
    const bus = options?.env?.DBUS_SESSION_BUS_ADDRESS;
    if (args.includes("Version")) {
      expect(args).toContain("--auto-start=no");
      probes.push(args.includes("--machine") ? "machine" : (bus ?? ""));
      return !args.includes("--machine") && bus === selected ? success(version) : missing;
    }
    children.push([command, bus, options?.env?.XDG_RUNTIME_DIR]);
    if (args.includes("LoadUnit")) {
      return { ...missing, stderr: "Call failed: Unit openclaw-gateway.service not found." };
    }
    return success("");
  });
  const close = vi.fn(async () => {});
  open.mockResolvedValue({
    close,
    verify: () => {},
    query: async (args) => (args.includes("Version") ? ["252.39"] : null),
  });
  if (scenario === "unavailable") {
    await expect(resolveTransport(env)).rejects.toMatchObject(unavailable);
    expect(await readTransport(env)).toBeUndefined();
    expect(probes).toEqual([custom, `unix:path=${runtimeDir}/bus`, "machine"]);
    return;
  }
  await expect(readService(env)).resolves.toBeNull();
  expect((await systemctl(env, ["status"])).code).toBe(0);
  const transport = await readTransport(env);
  expect(transport?.kind).toBe(scenario === "custom" ? "session-bus" : "private");
  if (scenario === "private") {
    expect(children).toEqual([
      ["systemctl", `unix:path=${runtimeDir}/systemd/private`, runtimeDir],
    ]);
    expect(close).toHaveBeenCalledTimes(2);
  } else {
    expect((await busctl(env, ["list"])).code).toBe(0);
    expect(children).toEqual([
      ["busctl", selected, runtimeDir],
      ["systemctl", selected, undefined],
      ["busctl", selected, runtimeDir],
    ]);
    expect(openSystemdUserManager).not.toHaveBeenCalled();
  }
  expect(probes).toEqual(
    scenario === "custom" ? [custom] : [custom, `unix:path=${runtimeDir}/bus`],
  );
  const payloadEnv = mergeGatewayServiceEnv(env, {
    programArguments: ["node", "gateway"],
    environment: {
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/payload/bus",
      XDG_RUNTIME_DIR: "/payload/runtime",
      USER: "payload",
    },
  });
  expect(await resolveTransport(payloadEnv)).toBe(transport);
  await fs.unlink(path.join(runtimeDir, "bus"));
  expect(await resolveTransport(env)).toBe(transport);
  expect(probes).toHaveLength(scenario === "custom" ? 1 : 2);
});

it.each([false, true])("isolates discovery custody (retired=%s)", async (retired) => {
  const held = createDeferredCore();
  let current = true;
  exec
    .mockImplementationOnce(async () => {
      await held.promise;
      current = !retired;
      return retired ? missing : success(version);
    })
    .mockResolvedValue(success(version));
  const first = resolveTransport(env, undefined, () => {
    if (!current) {
      throw new Error("original discovery retired");
    }
  }).catch((error: unknown) => error);
  const second = resolveTransport({ ...env, UNRELATED: "changed" });
  held.resolve();
  if (retired) {
    expect(await first).toMatchObject({ message: "original discovery retired" });
    await expect(second).resolves.toMatchObject({ kind: "session-bus" });
  } else {
    expect(await first).toBe(await second);
  }
  expect(execFileUtf8).toHaveBeenCalledTimes(retired ? 2 : 1);
});

it.each([
  { busctl: "ENOENT", systemctl: "ENOENT", reason: "service-manager-unavailable" },
  { busctl: "EACCES", systemctl: undefined, reason: "service-manager-access-denied" },
] as const)("tool error: $reason", async ({ busctl: busCode, systemctl: systemCode, reason }) => {
  exec.mockImplementation(async (command) => {
    const errorCode = command === "busctl" ? busCode : systemCode;
    return errorCode
      ? { ...missing, termination: "error", errorCode }
      : command === "systemctl"
        ? success("running")
        : missing;
  });
  await expect(resolveTransport(env)).rejects.toMatchObject({ reason });
});

it("retains the failed probe at its deadline", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  exec.mockImplementation(async () => {
    now = 1000;
    return { ...missing, code: 7 };
  });
  await expect(resolveTransport(env, 1000)).rejects.toMatchObject({
    reason: "systemd-inspection-deadline-exceeded",
    message: expect.stringContaining(
      "busctl --user session-bus Manager.Version: exit 7; Failed to connect to bus",
    ),
  });
  expect(execFileUtf8).toHaveBeenCalledOnce();
});

it("stops probes when custody retires", async () => {
  await fs.writeFile(path.join(home, "bus"), "");
  let current = true;
  exec.mockImplementation(async () => {
    current = false;
    return missing;
  });
  await expect(
    resolveTransport(transportEnv(home, "custom"), performance.now() + 1000, () => {
      if (!current) {
        throw new Error("read custody retired");
      }
    }),
  ).rejects.toThrow("read custody retired");
  expect(execFileUtf8).toHaveBeenCalledOnce();
});

it.each(["discovery", "connection", "query", "lost-socket"])(
  "preserves private %s failures without fallback",
  async (phase) => {
    await privateSocket(home);
    env = transportEnv(home, "missing-bus");
    exec.mockResolvedValue(missing);
    const refusal =
      phase === "lost-socket"
        ? new Error("Original systemd manager peer inspection is unavailable.")
        : new ServiceOwnershipRefusalError("systemd-manager-changed");
    const close = vi.fn(async () => {});
    const peer = connection(close);
    open.mockRejectedValue(refusal);
    if (phase !== "discovery") {
      open.mockResolvedValueOnce(peer);
    }
    if (phase === "query") {
      open.mockResolvedValue({
        ...peer,
        query: async () => {
          throw refusal;
        },
      });
    }
    let probes = 0;
    if (phase === "lost-socket") {
      await expect(resolveTransport(env)).resolves.toMatchObject({ kind: "private" });
      probes = exec.mock.calls.length;
    }
    const read = phase === "discovery" ? resolveTransport(env) : readService(env);
    if (phase === "lost-socket") {
      await expect(read).rejects.toMatchObject(unavailable);
      expect(execFileUtf8).toHaveBeenCalledTimes(probes);
    } else {
      await expect(read).rejects.toBe(refusal);
    }
    expect(exec.mock.calls.some(([, args]) => args.includes("--machine"))).toBe(false);
    expect(close).toHaveBeenCalledTimes(phase === "discovery" ? 0 : phase === "query" ? 2 : 1);
  },
);

it("routes direct root through the machine manager", async () => {
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), username: "root" });
  env = transportEnv(home, "missing");
  Object.assign(env, { USER: "root", LOGNAME: "root", SUDO_USER: undefined });
  exec.mockImplementation(async (command, args) => {
    if (!args.includes("--machine")) {
      return missing;
    }
    expect(args.slice(0, 3)).toEqual(["--machine", "root@", "--user"]);
    return success(command === "busctl" ? version : "running");
  });
  expect((await systemctl(env, ["status"])).code).toBe(0);
  expect(await readTransport(env)).toEqual({ kind: "machine", user: "root" });
  expect(execFileUtf8).toHaveBeenCalledTimes(3);
});

it.each([true, false])("rechecks timed-out admission (%s)", async (privateAvailable) => {
  if (privateAvailable) {
    await privateSocket(home);
  }
  env = transportEnv(home, "custom");
  const held = createDeferredCore();
  exec
    .mockImplementationOnce(async () => {
      await held.promise;
      return { ...missing, termination: "timeout" };
    })
    .mockImplementation(async (_command, args) =>
      args.includes("--machine") ? missing : success(version),
    );
  open.mockResolvedValue(connection());
  const first = resolveTransport(env, performance.now() + 100).catch((error: unknown) => error);
  const waiting = resolveTransport(env, undefined, undefined, "admission");
  held.resolve();
  expect(await first).toMatchObject(
    privateAvailable ? { kind: "private" } : { reason: "systemd-inspection-deadline-exceeded" },
  );
  const selected = await waiting;
  expect(selected).toMatchObject({ kind: "session-bus", address: env.DBUS_SESSION_BUS_ADDRESS });
  expect(await resolveTransport(env)).toBe(selected);
  expect(execFileUtf8).toHaveBeenCalledTimes(privateAvailable ? 2 : 3);
  expect(openSystemdUserManager).toHaveBeenCalledTimes(privateAvailable ? 1 : 0);
});
