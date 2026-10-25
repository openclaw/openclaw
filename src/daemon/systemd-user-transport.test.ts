import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { createDeferredCore } from "../shared/deferred.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { execFileUtf8 } from "./exec-file.js";
import { mergeGatewayServiceEnv } from "./service-env-merge.js";
import {
  ServiceOwnershipRefusalError,
  SystemdInspectionTimeout,
} from "./service-inspection-error.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { withGatewayServiceUpdateAuthority } from "./service-update-authority.js";
import { execBusctlUser as busctl, execSystemctlUser as systemctl } from "./systemd-exec.js";
import { nativeExit } from "./systemd-exec.test-support.js";
import { stopSystemdService } from "./systemd-lifecycle.js";
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
const success = (stdout = "") => ({ code: 0, termination: "exit" as const, stdout, stderr: "" });
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

it("tries the next route after a private manager probe times out", async () => {
  await privateSocket(home);
  Object.assign(env, { USER: "service", LOGNAME: "service", SUDO_USER: undefined });
  open.mockRejectedValue(new SystemdInspectionTimeout("native manager connection"));
  exec.mockImplementation(async (_command, args) =>
    args.includes("--machine") ? success(version) : missing,
  );
  await expect(resolveTransport(env)).resolves.toMatchObject({ kind: "machine", user: "service" });
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

it.each([
  ["discovery", false, [0, 0]],
  ["connection", false, [1, 0]],
  ["query", false, [1, 1]],
  ["disconnected-query", true, [1, 1]],
  ["lost-socket", true, [1, 0]],
] as const)(
  "preserves private %s failures without fallback",
  async (phase, unavailablePeer, closes) => {
    await privateSocket(home);
    env = transportEnv(home, "missing-bus");
    exec.mockResolvedValue(missing);
    const failure = unavailablePeer
      ? new Error("Original systemd manager peer inspection is unavailable.")
      : new ServiceOwnershipRefusalError("systemd-manager-changed");
    const discoveryClose = vi.fn(async () => {});
    const queryClose = vi.fn(async () => {});
    open.mockRejectedValue(failure);
    if (phase !== "discovery") {
      open.mockResolvedValueOnce(connection(discoveryClose));
    }
    if (phase === "query" || phase === "disconnected-query") {
      open.mockResolvedValue({
        ...connection(queryClose),
        query: async () => {
          throw failure;
        },
      });
    }
    if (phase === "lost-socket") {
      await expect(resolveTransport(env)).resolves.toMatchObject({ kind: "private" });
    }
    const read = phase === "discovery" ? resolveTransport(env) : readService(env);
    if (unavailablePeer) {
      await expect(read).rejects.toMatchObject(unavailable);
    } else {
      await expect(read).rejects.toBe(failure);
    }
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0]?.[1]).toContain("Version");
    expect([discoveryClose.mock.calls.length, queryClose.mock.calls.length]).toEqual(closes);
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

async function stopFixture(latency = 0, failedAttempts = 0) {
  const unit = path.join(home, ".config/systemd/user/openclaw-gateway.service");
  await fs.mkdir(path.dirname(unit), { recursive: true });
  await fs.writeFile(unit, "[Service]\nExecStart=/usr/bin/openclaw gateway\n");
  const stopEnv = {
    ...transportEnv(home),
    OPENCLAW_STATE_DIR: path.join(home, "state"),
    USER: "service",
    LOGNAME: "service",
    SUDO_USER: undefined,
  };
  let now = 0;
  let probes = 0;
  let remainingFailures = failedAttempts;
  const commands: string[] = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  exec.mockImplementation(async (_command, args, options) => {
    if (args.includes("Version")) {
      probes++;
      const timeout = options?.timeout ?? Number.POSITIVE_INFINITY;
      if (args.includes("--machine") || remainingFailures > 0 || latency > timeout) {
        if (!args.includes("--machine")) {
          remainingFailures--;
        }
        now += timeout;
        return { ...success(), code: 1, termination: "timeout", stderr: "probe timed out" };
      }
      now += latency;
      return success('s "252.39"');
    }
    commands.push(args[1] ?? "");
    return success();
  });
  const guard = vi.fn(() => {
    // A custody read can legitimately spend the lease database's five-second busy wait.
    now += 6000;
  });
  const warn = vi.fn();
  return {
    env: stopEnv,
    guard,
    warn,
    commands,
    probes: () => probes,
    elapsed: () => now,
    stop: (custodyMs = 0) =>
      withGatewayServiceUpdateAuthority(
        () => {
          now += custodyMs;
        },
        () =>
          stopSystemdService({
            env: stopEnv,
            stdout: new PassThrough(),
            assertCurrent: guard,
            warn,
          }),
      ),
  };
}

it("stops with a slow manager and slow custody checks", async () => {
  const f = await stopFixture(6000);
  await f.stop(6000);
  expect(f.commands).toEqual(["stop"]);
  expect(f.guard).toHaveBeenCalledOnce();
});

it("does not spend a cached manager's inspection budget on repeated update custody checks", async () => {
  const f = await stopFixture();
  await resolveTransport(f.env);
  await f.stop();
  expect(f.commands).toEqual(["stop"]);
  expect(f.probes()).toBe(1);
  expect(f.guard).toHaveBeenCalledOnce();
});

it("retries one transient inspection timeout before stopping", async () => {
  const f = await stopFixture(0, 1);
  await f.stop();
  expect(f.warn).toHaveBeenCalledOnce();
  expect(f.warn).toHaveBeenCalledWith(expect.stringMatching(/inspection.*retry/i));
  expect(f.commands.filter((command) => command === "stop")).toHaveLength(1);
});

it("keeps the original Gateway serving when both bounded manager inspections time out", async () => {
  const f = await stopFixture(Number.POSITIVE_INFINITY);
  await expect(f.stop()).rejects.toThrow(/Stalled check: machine Manager\.Version\./);
  expect(f.commands).not.toContain("stop");
  expect(f.warn).toHaveBeenCalledOnce();
  expect(f.elapsed()).toBeLessThanOrEqual(126_000);
});

it("refuses to stop when custody retires during manager inspection", async () => {
  const f = await stopFixture();
  f.guard.mockImplementation(() => {
    throw new Error("update custody retired");
  });
  await expect(f.stop()).rejects.toThrow("update custody retired");
  expect(f.commands).not.toContain("stop");
  expect(f.warn).not.toHaveBeenCalled();
});

it.each(["ownership refusal", "unsettled probe"])(
  "preserves %s at the inspection deadline despite retired custody",
  async (scenario) => {
    const f = await stopFixture();
    const failure =
      scenario === "ownership refusal"
        ? new ServiceOwnershipRefusalError("systemd-manager-changed")
        : new CommandProcessCleanupError();
    exec.mockImplementationOnce(async () => {
      vi.spyOn(performance, "now").mockReturnValue(60_000);
      f.guard.mockImplementation(() => {
        throw new Error("update custody retired");
      });
      throw failure;
    });
    await expect(f.stop()).rejects.toBe(failure);
    expect(execFileUtf8).toHaveBeenCalledOnce();
    expect(f.warn).not.toHaveBeenCalled();
  },
);

const commandEnv = (name: string) => ({
  USER: "owned",
  LOGNAME: "owned",
  HOME: "/test/owned",
  XDG_RUNTIME_DIR: `/runtime/${name}`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/runtime/${name}/bus`,
});
const unavailableCommand = nativeExit("", "Failed to connect to bus: No medium found", 1);
function fallback(spent: number, onProbe = () => {}) {
  vi.spyOn(process, "geteuid").mockReturnValue(1001);
  const clock = { elapsed: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.elapsed);
  exec.mockImplementation(async (_command, args) => {
    if (args.includes("--machine")) {
      return success(args.includes("Version") ? 's "252.39"' : "native result");
    }
    clock.elapsed += spent;
    onProbe();
    return unavailableCommand;
  });
  return clock;
}

it.each([450, 500])("does not give fallback a new deadline after %s ms", async (spent) => {
  fallback(spent);
  const result = await busctl(
    commandEnv(`budget-${spent}`),
    ["--auto-start=no", "call", "org.freedesktop.systemd1"],
    500,
  );
  expect(exec.mock.calls[0]?.[2]?.timeout).toBe(166);
  if (spent === 450) {
    expect(exec.mock.calls[1]?.[1]).toContain("owned@");
    expect(exec.mock.calls.map((call) => call[2]?.timeout)).toEqual([166, 25, 50]);
    expect(result.code).toBe(0);
  } else {
    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.termination).toBe("timeout");
    expect(result.code).not.toBe(0);
  }
});

it.each(["retired", "slow-guard", "stop"] as const)(
  "%s fallback retains the original authority and budget",
  async (mode) => {
    let active = true;
    const retired = mode === "retired" || mode === "stop";
    const operation = mode === "stop" ? "stop" : "load";
    const clock = fallback(50, () => {
      active = !retired;
    });
    const run = mode === "stop" ? systemctl : busctl;
    const args =
      mode === "stop"
        ? ["stop", "openclaw-gateway.service"]
        : (
            "--auto-start=no call :1.42 /org/freedesktop/systemd1 " +
            "org.freedesktop.systemd1.Manager LoadUnit s openclaw-gateway.service"
          ).split(" ");
    const result = run(commandEnv(`load-${mode}`), args, 500, () => {
      if (!active) {
        throw new Error(`original ${operation} owner retired`);
      }
      if (mode === "slow-guard" && clock.elapsed > 0) {
        clock.elapsed = 500;
      }
    });
    if (retired) {
      await expect(result).rejects.toThrow(`original ${operation} owner retired`);
    } else {
      const outcome = await result;
      expect([outcome.termination, outcome.inspectionReason]).toEqual(["exit", undefined]);
    }
    expect(exec).toHaveBeenCalledTimes(retired ? 1 : 3);
    expect(exec.mock.calls.filter((call) => call[1].includes("LoadUnit"))).toHaveLength(
      retired ? 0 : 1,
    );
  },
);
