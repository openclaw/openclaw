import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { execFileUtf8 } from "./exec-file.js";
import { mergeGatewayServiceEnv } from "./service-env-merge.js";
import { execBusctlUser, execSystemctlUser } from "./systemd-exec.js";
import { openSystemdUserManager } from "./systemd-peer-native.js";
import { readSystemdServiceExecStart } from "./systemd-service-files.js";
import { readSystemdUserTransport, resolveSystemdUserTransport } from "./systemd-user-transport.js";

vi.mock("./exec-file.js", () => ({ execFileUtf8: vi.fn() }));
vi.mock("./systemd-peer-native.js", () => ({ openSystemdUserManager: vi.fn() }));
const dirs = useAutoCleanupTempDirTracker(afterEach);
const success = (stdout: string) => ({ code: 0, termination: "exit" as const, stdout, stderr: "" });
const missing = {
  ...success(""),
  code: 1,
  stderr: "Failed to connect to bus: No such file or directory",
};
const version = 's "252.39"';

beforeEach(() => {
  vi.resetAllMocks();
  mockProcessPlatform("linux");
  vi.spyOn(process, "geteuid").mockReturnValue(1000);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["custom", "runtime", "private", "unavailable"] as const)(
  "shares the proven %s route across inspection and child commands",
  async (scenario) => {
    const home = dirs.make("openclaw-transport-");
    const runtimeDir = path.join(home, "runtime");
    await fs.mkdir(path.join(runtimeDir, "systemd"), { recursive: true });
    await fs.writeFile(path.join(runtimeDir, "bus"), "unrelated socket marker");
    if (scenario === "private") {
      await fs.writeFile(path.join(runtimeDir, "systemd/private"), "");
    }
    const custom = `unix:path=${home}/custom-bus`;
    const runtime = `unix:path=${runtimeDir}/bus`;
    const env = {
      HOME: home,
      USER: "service",
      LOGNAME: "service",
      SUDO_USER: undefined,
      XDG_RUNTIME_DIR: runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: custom,
    };
    const selected = scenario === "custom" ? custom : scenario === "runtime" ? runtime : undefined;
    const probes: string[] = [];
    const children: Array<{
      command: string;
      bus: string | undefined;
      runtime: string | undefined;
    }> = [];
    vi.mocked(execFileUtf8).mockImplementation(async (command, args, options) => {
      const bus = options?.env?.DBUS_SESSION_BUS_ADDRESS;
      if (args.includes("Version")) {
        expect(args).toContain("--auto-start=no");
        probes.push(args.includes("--machine") ? "machine" : (bus ?? ""));
        return !args.includes("--machine") && bus === selected ? success(version) : missing;
      }
      children.push({ command, bus, runtime: options?.env?.XDG_RUNTIME_DIR });
      if (args.includes("LoadUnit")) {
        return { ...missing, stderr: "Call failed: Unit openclaw-gateway.service not found." };
      }
      return success("");
    });
    const close = vi.fn(async () => {});
    vi.mocked(openSystemdUserManager).mockResolvedValue({
      close,
      verify: () => {},
      query: async (args) => (args.includes("Version") ? ["252.39"] : null),
    });
    if (scenario === "unavailable") {
      await expect(resolveSystemdUserTransport(env)).rejects.toMatchObject({
        reason: "systemd-user-bus-unavailable",
      });
      expect(await readSystemdUserTransport(env)).toBeUndefined();
      expect(probes).toEqual([custom, runtime, "machine"]);
      return;
    }
    await expect(readSystemdServiceExecStart(env, { requireEffective: true })).resolves.toBeNull();
    expect((await execSystemctlUser(env, ["status"])).code).toBe(0);
    const transport = await readSystemdUserTransport(env);
    expect(transport?.kind).toBe(
      scenario === "custom" ? "session-bus" : scenario === "runtime" ? "runtime-bus" : "private",
    );
    if (scenario === "private") {
      expect(children).toEqual([
        {
          command: "systemctl",
          bus: `unix:path=${runtimeDir}/systemd/private`,
          runtime: runtimeDir,
        },
      ]);
      expect(close).toHaveBeenCalledTimes(2);
    } else {
      expect((await execBusctlUser(env, ["list"])).code).toBe(0);
      expect(children).toEqual([
        { command: "busctl", bus: selected, runtime: runtimeDir },
        { command: "systemctl", bus: selected, runtime: undefined },
        { command: "busctl", bus: selected, runtime: runtimeDir },
      ]);
      expect(openSystemdUserManager).not.toHaveBeenCalled();
    }
    expect(probes).toEqual(scenario === "custom" ? [custom] : [custom, runtime]);
    const payloadEnv = mergeGatewayServiceEnv(env, {
      programArguments: ["node", "gateway"],
      environment: {
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/payload/bus",
        XDG_RUNTIME_DIR: "/payload/runtime",
        USER: "payload",
      },
    });
    expect(await resolveSystemdUserTransport(payloadEnv)).toBe(transport);
    await fs.unlink(path.join(runtimeDir, "bus"));
    expect(await resolveSystemdUserTransport(env)).toBe(transport);
    expect(probes).toHaveLength(scenario === "custom" ? 1 : 2);
  },
);

it("deduplicates concurrent discovery without retaining caller environment", async () => {
  const home = dirs.make("openclaw-concurrent-transport-");
  const env = {
    HOME: home,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/bus`,
    XDG_RUNTIME_DIR: home,
  };
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(execFileUtf8).mockImplementation(async () => {
    await held;
    return success(version);
  });
  const first = resolveSystemdUserTransport(env);
  const second = resolveSystemdUserTransport({ ...env, UNRELATED: "changed" });
  release();
  expect(await first).toBe(await second);
  expect(execFileUtf8).toHaveBeenCalledOnce();
});

it.each([
  { busctl: "ENOENT", systemctl: "ENOENT", reason: "service-manager-unavailable" },
  { busctl: "ENOENT", systemctl: undefined, reason: "systemd-busctl-unavailable" },
  { busctl: "EACCES", systemctl: undefined, reason: "service-manager-access-denied" },
  { busctl: undefined, systemctl: undefined, reason: "systemd-user-bus-unavailable" },
  { busctl: undefined, systemctl: "offline", reason: "service-manager-unavailable" },
  { busctl: undefined, systemctl: "not-booted", reason: "service-manager-unavailable" },
] as const)(
  "distinguishes missing native tools from $reason ($busctl, $systemctl)",
  async ({ busctl, systemctl, reason }) => {
    const home = dirs.make("openclaw-missing-manager-");
    vi.mocked(execFileUtf8).mockImplementation(async (command) => {
      const errorCode =
        command === "busctl" ? busctl : systemctl === "ENOENT" ? systemctl : undefined;
      if (command === "systemctl" && systemctl === "offline") {
        return { ...missing, stdout: "offline\n", stderr: "" };
      }
      if (command === "systemctl" && systemctl === "not-booted") {
        return {
          ...missing,
          stderr: "System has not been booted with systemd as init system (PID 1). Can't operate.",
        };
      }
      return errorCode
        ? { ...missing, termination: "error", errorCode }
        : command === "systemctl"
          ? success("running")
          : missing;
    });
    await expect(
      resolveSystemdUserTransport({
        HOME: home,
        XDG_RUNTIME_DIR: home,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/bus`,
      }),
    ).rejects.toMatchObject({ reason });
  },
);

it("does not let a short failed discovery poison the next caller", async () => {
  const home = dirs.make("openclaw-short-transport-");
  const env = {
    HOME: home,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/bus`,
    XDG_RUNTIME_DIR: home,
  };
  vi.mocked(execFileUtf8).mockResolvedValue({ ...missing, termination: "timeout" });
  await expect(resolveSystemdUserTransport(env, performance.now() + 100)).rejects.toThrow();
  vi.mocked(execFileUtf8).mockResolvedValue(success(version));
  await expect(resolveSystemdUserTransport(env)).resolves.toMatchObject({
    kind: "session-bus",
    address: env.DBUS_SESSION_BUS_ADDRESS,
  });
});

it("stops discovery when its caller retires between probes", async () => {
  const home = dirs.make("openclaw-retired-transport-");
  await fs.writeFile(path.join(home, "bus"), "");
  let current = true;
  vi.mocked(execFileUtf8).mockImplementation(async () => {
    current = false;
    return missing;
  });
  await expect(
    resolveSystemdUserTransport(
      { HOME: home, XDG_RUNTIME_DIR: home, DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/custom` },
      performance.now() + 1000,
      () => {
        if (!current) {
          throw new Error("read custody retired");
        }
      },
    ),
  ).rejects.toThrow("read custody retired");
  expect(execFileUtf8).toHaveBeenCalledOnce();
});

it("reports a lost selected private socket without reselecting or blaming the definition", async () => {
  const home = dirs.make("openclaw-lost-private-");
  await fs.mkdir(path.join(home, "systemd"));
  await fs.writeFile(path.join(home, "systemd/private"), "");
  const env = {
    HOME: home,
    XDG_RUNTIME_DIR: home,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/missing-bus`,
  };
  vi.mocked(execFileUtf8).mockResolvedValue(missing);
  const close = vi.fn(async () => {});
  vi.mocked(openSystemdUserManager)
    .mockResolvedValueOnce({ close, verify: () => {}, query: async () => ["252.39"] })
    .mockRejectedValue(new Error("Original systemd manager peer inspection is unavailable."));
  await expect(resolveSystemdUserTransport(env)).resolves.toMatchObject({ kind: "private" });
  const probes = vi.mocked(execFileUtf8).mock.calls.length;
  await expect(readSystemdServiceExecStart(env, { requireEffective: true })).rejects.toMatchObject({
    reason: "systemd-user-bus-unavailable",
  });
  expect(execFileUtf8).toHaveBeenCalledTimes(probes);
  expect(close).toHaveBeenCalledOnce();
});

it("retains direct-root machine routing at the selection owner", async () => {
  const home = dirs.make("openclaw-root-transport-");
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), username: "root" });
  const env = {
    HOME: home,
    USER: "root",
    LOGNAME: "root",
    SUDO_USER: undefined,
    XDG_RUNTIME_DIR: home,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/missing`,
  };
  vi.mocked(execFileUtf8).mockImplementation(async (command, args) => {
    if (!args.includes("--machine")) {
      return missing;
    }
    expect(args.slice(0, 3)).toEqual(["--machine", "root@", "--user"]);
    return success(command === "busctl" ? version : "running");
  });
  expect((await execSystemctlUser(env, ["status"])).code).toBe(0);
  expect(await readSystemdUserTransport(env)).toEqual({ kind: "machine", user: "root" });
  expect(execFileUtf8).toHaveBeenCalledTimes(3);
});

it.each([true, false])(
  "rechecks timed-out discovery for a waiting admission (private=%s)",
  async (privateAvailable) => {
    const home = dirs.make("openclaw-waiting-admission-");
    if (privateAvailable) {
      await fs.mkdir(path.join(home, "systemd"));
      await fs.writeFile(path.join(home, "systemd/private"), "");
    }
    const env = {
      HOME: home,
      XDG_RUNTIME_DIR: home,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/custom`,
    };
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(execFileUtf8)
      .mockImplementationOnce(async () => {
        await held;
        return { ...missing, termination: "timeout" };
      })
      .mockImplementation(async (_command, args) =>
        args.includes("--machine") ? missing : success(version),
      );
    vi.mocked(openSystemdUserManager).mockResolvedValue({
      query: async () => ["252.39"],
      close: async () => {},
      verify: () => {},
    });
    const first = resolveSystemdUserTransport(env, performance.now() + 100).catch(
      (error: unknown) => error,
    );
    const waiting = resolveSystemdUserTransport(env, undefined, undefined, "admission");
    release();
    expect(await first).toMatchObject(
      privateAvailable ? { kind: "private" } : { reason: "systemd-user-bus-unavailable" },
    );
    const selected = await waiting;
    expect(selected).toMatchObject({ kind: "session-bus", address: env.DBUS_SESSION_BUS_ADDRESS });
    expect(await resolveSystemdUserTransport(env)).toBe(selected);
    expect(execFileUtf8).toHaveBeenCalledTimes(privateAvailable ? 2 : 3);
    expect(openSystemdUserManager).toHaveBeenCalledTimes(privateAvailable ? 1 : 0);
  },
);

it("does not inherit another discovery caller's retired custody", async () => {
  const home = dirs.make("openclaw-discovery-custody-");
  const env = {
    HOME: home,
    XDG_RUNTIME_DIR: home,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/bus`,
  };
  let release: () => void = () => {};
  let current = true;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(execFileUtf8)
    .mockImplementationOnce(async () => {
      await held;
      current = false;
      return missing;
    })
    .mockResolvedValue(success(version));
  const first = resolveSystemdUserTransport(env, undefined, () => {
    if (!current) {
      throw new Error("original discovery retired");
    }
  }).catch((error: unknown) => error);
  const waiting = resolveSystemdUserTransport(env, undefined, () => {});
  release();
  expect(await first).toMatchObject({ message: "original discovery retired" });
  await expect(waiting).resolves.toMatchObject({ kind: "session-bus" });
  expect(execFileUtf8).toHaveBeenCalledTimes(2);
});
