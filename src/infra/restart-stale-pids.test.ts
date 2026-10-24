import fs from "node:fs";
import path from "node:path";
import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as pidAlive from "../shared/pid-alive.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import * as sleep from "../utils/sleep.js";
import {
  cleanStaleGatewayProcessesSync,
  findGatewayPidsOnPortSync,
  terminateStaleGatewayPids,
} from "./restart-stale-pids.js";

type WindowsProcesses = typeof import("./windows-port-pids.js");
const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  ancestry: vi.fn<typeof import("@openclaw/proc-safe/identity").readProcessAncestry>(),
  spawn: vi.fn(),
  port: vi.fn(() => 18789),
  warn: vi.fn(),
  owner: vi.fn<typeof import("./gateway-owner-lease.js").readGatewayOwnerLease>(),
  windowsPids: vi.fn<WindowsProcesses["readWindowsListeningPidsOnPortSync"]>(),
  windowsListeners: vi.fn<WindowsProcesses["readWindowsListeningPidsResultSync"]>(),
  windowsArgs: vi.fn<WindowsProcesses["readWindowsProcessArgsSync"]>(),
  windowsArgsResult: vi.fn<WindowsProcesses["readWindowsProcessArgsResultSync"]>(),
  readFile: vi.fn(),
  readlink: vi.fn(),
  darwin: vi.fn(),
  argv: new Map<number, string[]>(),
}));
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/identity")>()),
  readProcessAncestry: mocks.ancestry,
  readProcessIdentity: mocks.identity,
}));

vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:fs")>("node:fs"),
    (actual) => ({
      readlinkSync: new Proxy(actual.readlinkSync, {
        apply: (_target, _receiver, args) => mocks.readlink(...args),
      }),
      readFileSync: ((pathname: unknown, encoding?: unknown) => {
        const pid = Number(/^\/proc\/(\d+)\/cmdline$/.exec(String(pathname))?.[1]);
        return mocks.argv.get(pid)?.join("\0") ?? mocks.readFile(pathname, encoding);
      }) as typeof actual.readFileSync,
    }),
    { mirrorToDefault: true },
  );
});

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawnSync: (...args: unknown[]) => mocks.spawn(...args),
      execFileSync: vi.fn(),
    },
  );
});

vi.mock("../config/paths.js", () => ({
  resolveGatewayPort: () => mocks.port(),
}));

vi.mock("./ports-lsof.js", () => ({
  resolveLsofCommandSync: vi.fn(() => "lsof"),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: mocks.warn }),
}));

vi.mock("../process/supervisor/darwin-process-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/supervisor/darwin-process-command.js")>()),
  readDarwinProcessCommand: mocks.darwin,
}));

vi.mock("./gateway-owner-lease.js", () => ({
  readGatewayOwnerLease: mocks.owner,
}));

vi.mock("./windows-port-pids.js", () => ({
  readWindowsListeningPidsOnPortSync: mocks.windowsPids,
  readWindowsListeningPidsResultSync: mocks.windowsListeners,
  readWindowsProcessArgsSync: mocks.windowsArgs,
  readWindowsProcessArgsResultSync: mocks.windowsArgsResult,
}));

vi.mock("./windows-install-roots.js", () => ({
  getWindowsInstallRoots: () => ({
    systemRoot: "C:\\Windows",
    programFiles: "C:\\Program Files",
    programFilesX86: "C:\\Program Files (x86)",
    programW6432: null,
  }),
}));

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function gatewayLsofOutput(pids: number[]): string {
  for (const pid of pids) {
    mocks.argv.set(pid, ["openclaw-gateway"]);
  }
  return pids.map((pid) => `p${pid}\ncopenclaw-gateway\n`).join("");
}

function processIdentity(pid: number, parentPid: number) {
  return { pid, parentPid, startTimeMicros: 100, startTimeResolutionMicros: 1, exited: false };
}

function gatewayPackage(root: string, name = "openclaw") {
  const script = path.join(root, "dist", "index.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
  return script;
}

function windowsGateway(pid: number) {
  mocks.windowsListeners.mockReturnValue({ ok: true, pids: [pid] });
  mocks.windowsArgsResult.mockReturnValue({ ok: true, args: ["openclaw", "gateway"] });
}

function mockNativeListeners(
  entries: Array<{ pid: number; argv: string[]; cwd?: string }>,
  procfs = true,
) {
  const listeners = new Map(entries.map((entry) => [entry.pid, entry]));
  mocks.darwin.mockImplementation((pid: number) => ({ argv: listeners.get(pid)?.argv }));
  mocks.readFile.mockImplementation((file: string) => {
    if (file.startsWith("/proc/")) {
      const pid = Number(/^\/proc\/(\d+)\/cmdline$/.exec(file)?.[1]);
      if (procfs && listeners.has(pid)) {
        return listeners.get(pid)!.argv.join("\0");
      }
      throw Object.assign(new Error("procfs unavailable"), { code: "ENOENT" });
    }
    return actualFs.readFileSync(file, "utf8");
  });
  mocks.readlink.mockImplementation((file: unknown) => {
    const pid = Number(/^\/proc\/(\d+)\/cwd$/.exec(String(file))?.[1]);
    const cwd = listeners.get(pid)?.cwd;
    if (!cwd) {
      throw Object.assign(new Error("working directory unavailable"), { code: "EACCES" });
    }
    return cwd;
  });
  mocks.spawn.mockImplementation((command: string, args: string[]) => {
    if (command === "lsof") {
      return lsof({
        stdout: entries.map(({ pid }) => `p${pid}\ncnode\n`).join(""),
      });
    }
    const pid = Number(args[2]);
    const entry = listeners.get(pid);
    if (command === "/usr/sbin/lsof") {
      return entry?.cwd
        ? lsof({ stdout: `p${pid}\0\nfcwd\0n${entry.cwd}\0\n` })
        : lsof({ status: 1 });
    }
    return lsof({
      stdout:
        args[0] === "-ww" ? (entry?.argv.map((arg) => JSON.stringify(arg)).join(" ") ?? "") : "",
    });
  });
}

type MockLsofResult = {
  error: Error | null;
  status: number | null;
  stdout: string;
  stderr: string;
};

type MockWindowsListeningPidsResult =
  | { ok: true; pids: number[] }
  | { ok: false; permanent: boolean };

function lsof(overrides: Partial<MockLsofResult> = {}): MockLsofResult {
  return {
    error: null,
    status: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

function busy(pids: number | number[]) {
  return lsof({ stdout: gatewayLsofOutput(typeof pids === "number" ? [pids] : pids) });
}

function lsofError(code: string, message: string) {
  return lsof({ error: Object.assign(new Error(message), { code }), status: null });
}

function pollAfterScan(
  stalePids: number | number[],
  resolvePoll: (call: number) => MockLsofResult = () => lsof({ status: 1 }),
  onScan?: () => void,
): () => number {
  let call = 0;
  mocks.spawn.mockImplementation((command: unknown) => {
    if (command !== "lsof") {
      return lsof();
    }
    call += 1;
    if (call === 1) {
      onScan?.();
      return busy(stalePids);
    }
    return resolvePoll(call);
  });
  return () => call;
}

function mockWindowsPoll(initial: MockWindowsListeningPidsResult, poll = initial): void {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.windowsListeners.mockImplementation((_port, timeoutMs) => {
    if (timeoutMs === 400) {
      now += 2001;
      return poll;
    }
    return initial;
  });
}

function expectWarningContaining(text: string): void {
  expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining(text));
}

function recordedOwner(pid: number, state: "live" | "dead" = "live", expired = true) {
  return {
    owner: "gateway-owner",
    pid,
    host: "gateway-test-host",
    startedAt: 1000,
    port: 18789,
    mode: "supervised" as const,
    supervisor: { kind: "schtasks" as const, name: "OpenClaw Gateway" },
    state,
    expired,
  };
}

beforeEach(() => {
  mocks.ancestry.mockReset().mockReturnValue(null);
  // These liveness fixtures drive process.kill independently of a native process table.
  mocks.identity.mockReset().mockImplementation(() => {
    throw new ProcSafeError("helper-unavailable", "fixture uses signal probes");
  });
  mocks.spawn.mockReset();
  mocks.argv.clear();
  mocks.readlink.mockReset().mockImplementation(actualFs.readlinkSync);
  mocks.darwin.mockReset().mockImplementation((pid: number) => {
    const argv = mocks.argv.get(pid);
    return argv ? { argv } : undefined;
  });
  mocks.owner.mockReset().mockReturnValue(undefined);
  mocks.port.mockReset().mockReturnValue(18789);
  mocks.warn.mockReset();
  mocks.windowsPids.mockReset().mockReturnValue([]);
  mocks.windowsListeners.mockReset().mockReturnValue({ ok: true, pids: [] });
  mocks.windowsArgs.mockReset().mockReturnValue(null);
  mocks.windowsArgsResult.mockReset().mockReturnValue({ ok: true, args: null });
  mocks.readFile.mockReset().mockImplementation(() => {
    throw Object.assign(new Error("ENOENT: test default"), { code: "ENOENT" });
  });
  vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.skipIf(process.platform === "win32")("restart-stale-pids", () => {
  function withStubbedPpid<T>(ppid: number, fn: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(process, "ppid");
    Object.defineProperty(process, "ppid", { configurable: true, value: ppid });
    try {
      return fn();
    } finally {
      if (descriptor) {
        Object.defineProperty(process, "ppid", descriptor);
      }
    }
  }

  it.each([
    [lsof({ status: 1 }), null],
    [lsof({ status: 2, stderr: "lsof error" }), "lsof exited with status 2"],
    [lsofError("ENOENT", "lsof not found"), null],
    [
      lsofError("EACCES", "permission denied"),
      "lsof failed during initial stale-pid scan for port 18789: EACCES",
    ],
    [
      lsof({ error: new Error("lsof unavailable"), status: null }),
      "lsof failed during initial stale-pid scan for port 18789: lsof unavailable",
    ],
  ] as const)("handles failed initial scan %j", (result, warning) => {
    mocks.spawn.mockReturnValue(result);
    expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([]);
    if (warning) {
      expectWarningContaining(warning);
    } else {
      expect(mocks.warn).not.toHaveBeenCalled();
    }
  });

  it.each([
    ...(["linux", "darwin", "freebsd", "win32"] as const).map((platform) => ({
      platform,
      native: true,
    })),
    { platform: "win32", native: false },
  ] as const)(
    "excludes ancestors on $platform (native walker: $native)",
    ({ platform, native }) => {
      const parentPid = process.pid + 2003;
      const grandparentPid = process.pid + 2004;
      const stalePid = process.pid + 2005;
      mocks.ancestry.mockReturnValue(
        native
          ? {
              chain: [
                processIdentity(process.pid, parentPid),
                processIdentity(parentPid, grandparentPid),
                processIdentity(grandparentPid, 1),
              ],
              complete: true,
              stoppedBy: "root",
            }
          : null,
      );
      const listeners = [parentPid, ...(native ? [grandparentPid] : []), stalePid];
      const output = gatewayLsofOutput(listeners);
      mocks.spawn.mockImplementation((command: string) =>
        lsof({ stdout: command === "ps" ? "openclaw gateway" : output }),
      );
      mocks.windowsPids.mockReturnValue(listeners);
      mocks.windowsArgs.mockReturnValue(["openclaw", "gateway"]);
      withMockedPlatform(platform, () => {
        const pids = withStubbedPpid(parentPid, () => findGatewayPidsOnPortSync(18789));
        expect(pids).toEqual([stalePid]);
      });
      if (!native) {
        expect(mocks.windowsArgs).not.toHaveBeenCalledWith(parentPid);
      }
    },
  );

  it("protects an unreadable transitive parent without treating its identity as verified", async () => {
    const { inspectSelfAndAncestorPidsSync } = await import("./restart-stale-pids.js");
    const parentPid = process.pid + 2003;
    const unknownPid = process.pid + 2004;
    mocks.ancestry.mockReturnValue({
      chain: [processIdentity(process.pid, parentPid), processIdentity(parentPid, unknownPid)],
      complete: false,
      stoppedBy: "unreadable-parent",
    });
    withStubbedPpid(parentPid, () => {
      expect(inspectSelfAndAncestorPidsSync()).toEqual({
        pids: new Set([process.pid, parentPid, unknownPid]),
        complete: false,
      });
      expect(inspectSelfAndAncestorPidsSync(undefined, { requireVerifiedParent: true })).toEqual({
        pids: new Set([process.pid, parentPid]),
        complete: false,
      });
    });
  });

  it("returns each verified gateway once from mixed lsof records", () => {
    const first = process.pid + 700;
    const second = process.pid + 701;
    const unknown = process.pid + 702;
    const foreign = process.pid + 703;
    const stdout = `p0\ncopenclaw-gateway\np${unknown}\nf8\np${foreign}\ncnode\n${gatewayLsofOutput(
      [first, process.pid, second, first],
    )}`;
    mocks.argv.set(second, ["openclaw", "gateway"]);
    mocks.argv.set(foreign, ["python", "server.py"]);
    mocks.spawn.mockImplementation(
      (command: unknown, _args: unknown, options: { timeout?: number }) => {
        if (command !== "lsof") {
          return lsof();
        }
        return (options.timeout ?? 0) >= 3000
          ? lsof({ stdout })
          : lsofError("ETIMEDOUT", "lsof timed out");
      },
    );
    expect(findGatewayPidsOnPortSync(18789)).toEqual([first, second]);
  });

  it("keeps polling through inconclusive probes until the port is definitively free", () => {
    const stalePid = process.pid + 501;
    const polls = [
      () => {
        throw new Error("lsof unavailable");
      },
      () => lsof({ error: new Error("timeout"), status: null }),
      () => lsof({ status: 2, stderr: "permission denied" }),
      () => lsof({ stdout: "p111abc\ncopenclaw-gateway\n" }),
      () => lsof({ status: 1, stdout: "p123\nccaddy\n" }),
      () => lsof({ status: 1 }),
    ];
    const calls = pollAfterScan(stalePid, (call) => polls[call - 2]!());
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    expect(cleanStaleGatewayProcessesSync(19999)).toEqual([stalePid]);
    expect(mocks.port).not.toHaveBeenCalled();
    expect(calls()).toBe(1 + polls.length);
    expect(kill).toHaveBeenCalledWith(stalePid, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(stalePid, "SIGKILL");
  });

  it.each([
    ["darwin", "owner", "start"],
    ["darwin", "owner", "scan"],
    ["darwin", "owner", "SIGTERM"],
    ["win32", "owner", "SIGTERM"],
    ["darwin", "authority", "scan"],
    ["darwin", "authority", "SIGTERM"],
  ] as const)("stops cleanup on %s when %s changes at %s", (platform, guard, boundary) => {
    const pid = process.pid + 7100;
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-synchronous-cleanup" };
    const events: string[] = [];
    let revoked = boundary === "start";
    let scanned = false;
    const record = (event: string) => {
      events.push(event);
      if (event === boundary) {
        revoked = true;
      }
    };
    mocks.owner.mockImplementation((params) =>
      guard === "owner" && revoked && params?.env?.OPENCLAW_STATE_DIR === env.OPENCLAW_STATE_DIR
        ? recordedOwner(pid)
        : undefined,
    );
    const scan = () => {
      if (scanned) {
        return false;
      }
      scanned = true;
      record("scan");
      return true;
    };
    mocks.spawn.mockImplementation((command: string, args: string[]) => {
      if (command === "lsof") {
        return scan() ? busy(pid) : lsof({ status: 1 });
      }
      if (command.endsWith("taskkill.exe")) {
        record(args.includes("/F") ? "SIGKILL" : "SIGTERM");
      }
      return lsof();
    });
    mocks.windowsListeners.mockImplementation(() => ({ ok: true, pids: scan() ? [pid] : [] }));
    mocks.windowsArgsResult.mockReturnValue({ ok: true, args: ["openclaw", "gateway"] });
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (typeof signal === "string") {
        record(signal);
      }
      return true;
    });
    withMockedPlatform(platform, () =>
      withStubbedPpid(0, () =>
        cleanStaleGatewayProcessesSync(18789, {
          env,
          assertCurrent: () => {
            if (guard === "authority" && revoked) {
              throw new Error("update owner revoked");
            }
          },
        }),
      ),
    );
    expect(events).toEqual(
      boundary === "start" ? [] : boundary === "scan" ? ["scan"] : ["scan", "SIGTERM"],
    );
    if (boundary !== "SIGTERM") {
      expect(kill).not.toHaveBeenCalled();
    }
  });

  it("continues cleanup and port polling when individual process signals fail", () => {
    const termDeniedPid = process.pid + 198;
    const killDeniedPid = process.pid + 199;
    const calls = pollAfterScan([termDeniedPid, killDeniedPid]);

    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === termDeniedPid && signal === "SIGTERM") {
        throw Object.assign(new Error("term permission denied"), { code: "EPERM" });
      }
      if (pid === killDeniedPid && signal === "SIGKILL") {
        throw Object.assign(new Error("kill permission denied"), { code: "EACCES" });
      }
      return true;
    });

    expect(cleanStaleGatewayProcessesSync()).toEqual([killDeniedPid]);
    expect(killSpy).toHaveBeenCalledWith(termDeniedPid, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(killDeniedPid, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(killDeniedPid, 0);
    expect(killSpy).toHaveBeenCalledWith(killDeniedPid, "SIGKILL");
    expectWarningContaining(`failed to send SIGTERM to stale gateway process ${termDeniedPid}`);
    expectWarningContaining(`failed to send SIGKILL to stale gateway process ${killDeniedPid}`);
    expect(calls()).toBe(2);
  });

  it.each(["fixed", "replacement", "unreadable"] as const)(
    "protects managed PIDs with a %s identity",
    (mode) => {
      const oldPid = process.pid + 4100;
      const protectedPid = oldPid + 1;
      const stalePid = oldPid + 2;
      let scanned = false;
      pollAfterScan([1, protectedPid, stalePid], undefined, () => {
        scanned = true;
      });
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      const resolveProtectedPid =
        mode === "fixed"
          ? undefined
          : () => {
              expect(scanned).toBe(true);
              if (mode === "unreadable") {
                throw new Error("launchctl print failed");
              }
              return protectedPid;
            };
      const result = withStubbedPpid(1, () =>
        cleanStaleGatewayProcessesSync(18789, {
          protectedPid: mode === "fixed" ? protectedPid : oldPid,
          resolveProtectedPid,
        }),
      );
      expect(result).toEqual(mode === "unreadable" ? [] : [stalePid]);
      if (mode === "unreadable") {
        expectWarningContaining("launchctl print failed");
        expect(kill).not.toHaveBeenCalled();
      } else {
        expect(kill).toHaveBeenCalledWith(stalePid, "SIGTERM");
        for (const pid of [1, oldPid, protectedPid]) {
          expect(kill).not.toHaveBeenCalledWith(pid, expect.anything());
        }
      }
    },
  );

  it("reports the raw owner lease read failure without scanning or signaling processes", () => {
    const cause =
      "EACCES: permission denied reading gateway owner lease password=synthetic-review-only-abcdefghijk";
    mocks.owner.mockImplementationOnce(() => {
      throw new Error(cause);
    });
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    expect(cleanStaleGatewayProcessesSync(18789)).toEqual([]);
    expectWarningContaining("stale gateway process cleanup failed:");
    expectWarningContaining(cause);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("stops polling after permanent EPERM", () => {
    const stalePid = process.pid + 300;
    const calls = pollAfterScan(stalePid, () => lsofError("EPERM", "unavailable"));
    vi.spyOn(process, "kill").mockReturnValue(true);
    expect(cleanStaleGatewayProcessesSync()).toEqual([stalePid]);
    expect(calls()).toBe(2);
  });

  it("still polls when stale pids exit before SIGTERM", () => {
    const stalePid = process.pid + 304;
    const calls = pollAfterScan(stalePid, () => lsof({ status: 1 }));
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    expect(cleanStaleGatewayProcessesSync()).toEqual([]);
    expect(calls()).toBe(2);
  });

  it("does not force-kill a stale PID that canonical liveness reports dead", () => {
    const stalePid = process.pid + 499;
    pollAfterScan(stalePid);
    vi.spyOn(pidAlive, "isPidAlive").mockReturnValue(false);
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    expect(cleanStaleGatewayProcessesSync(18789)).toStrictEqual([stalePid]);
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(stalePid, "SIGKILL");
  });

  it.each(["after cleanup", "listener scan", "argv inspection"] as const)(
    "waits on inconclusive Windows probes at %s",
    (stage) =>
      withMockedPlatform("win32", () => {
        const pid = process.pid + 910;
        const failure = { ok: false, permanent: false } as const;
        windowsGateway(pid);
        mocks.spawn.mockReturnValue(lsof());
        const initial: MockWindowsListeningPidsResult =
          stage === "listener scan" ? failure : { ok: true, pids: [pid] };
        mockWindowsPoll(initial, stage === "after cleanup" ? failure : initial);
        if (stage === "argv inspection") {
          mocks.windowsArgsResult.mockReturnValue(failure);
        }
        let aliveChecks = 0;
        const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
          if (stage === "after cleanup" && signal === 0 && target === pid && ++aliveChecks >= 3) {
            throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
          }
          return true;
        });
        expect(cleanStaleGatewayProcessesSync()).toEqual(stage === "after cleanup" ? [pid] : []);
        expectWarningContaining("port 18789 still in use after 2000ms");
        if (stage === "after cleanup") {
          expect(kill).toHaveBeenCalledWith(pid, 0);
        } else {
          expect(kill).not.toHaveBeenCalled();
        }
      }),
  );
  it("treats Windows EPERM liveness checks as alive and still forces taskkill", () => {
    const stalePid = process.pid + 912;
    vi.stubEnv("SystemRoot", "C:\\PoisonedWindows");
    withMockedPlatform("win32", () => {
      let fakeNow = 0;
      vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
      windowsGateway(stalePid);
      mocks.spawn.mockImplementation((command: string) => {
        if (
          command.endsWith("\\powershell.exe") ||
          command === "C:\\Windows\\System32\\taskkill.exe"
        ) {
          return { error: null, status: 1, stdout: "", stderr: "access denied" };
        }
        throw new Error(`Unexpected Windows process command: ${command}`);
      });
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (signal === 0 && pid === stalePid) {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        }
        return true;
      });
      vi.mocked(Atomics.wait).mockImplementation((_array, _index, _value, timeout) => {
        fakeNow += timeout ?? 0;
        return "timed-out";
      });

      expect(cleanStaleGatewayProcessesSync()).toStrictEqual([]);
      expect(mocks.spawn.mock.calls.map(([command, args]) => [command, args])).toEqual([
        ["C:\\Windows\\System32\\taskkill.exe", ["/T", "/PID", String(stalePid)]],
        ["C:\\Windows\\System32\\taskkill.exe", ["/F", "/T", "/PID", String(stalePid)]],
      ]);
    });
  });
});

it("reports an unclassified Windows listener without reclaiming its process", () => {
  const pid = process.pid + 901;
  mocks.windowsListeners.mockReturnValue({ ok: true, pids: [pid] });
  mocks.windowsArgsResult.mockReturnValue({
    ok: true,
    args: ["node", "dist/index.js", "gateway"],
  });
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  withMockedPlatform("win32", () => {
    expect(cleanStaleGatewayProcessesSync(18789)).toEqual([]);
  });
  expect(mocks.warn).toHaveBeenCalledWith(
    expect.stringContaining(`Could not classify PID ${pid}:`),
  );
  expect(kill).not.toHaveBeenCalled();
});

it.each(["linux", "darwin"] as const)(
  "verifies relative gateway scripts against each listener's native cwd on %s",
  async (platform) => {
    const root = tempDirs.make("gateway-pid-cwd-");
    const ownedPid = process.pid + 401;
    const unrelatedPid = process.pid + 402;
    const unknownPid = process.pid + 403;
    const entries = (
      [
        [ownedPid, "openclaw"],
        [unrelatedPid, "other-service"],
      ] as const
    ).map(([pid, name]) => {
      const cwd = path.join(
        root,
        platform === "darwin" && process.platform !== "win32"
          ? `${pid}\nworking directory`
          : String(pid),
      );
      gatewayPackage(cwd, name);
      return { pid, cwd, argv: ["node", "dist/index.js", "gateway"] };
    });
    mockNativeListeners([
      ...entries,
      { pid: unknownPid, argv: ["node", "dist/index.js", "gateway"] },
    ]);
    withMockedPlatform(platform, () => {
      expect(findGatewayPidsOnPortSync(18789)).toEqual([ownedPid]);
    });
  },
);

it("uses quoted ps argv when Linux procfs is unavailable", () => {
  const root = path.join(tempDirs.make("gateway-native-argv-"), "application with spaces");
  const pid = process.pid + 701;
  mockNativeListeners([{ pid, argv: ["node", gatewayPackage(root), "gateway"] }], false);
  withMockedPlatform("linux", () => expect(findGatewayPidsOnPortSync(18789)).toEqual([pid]));
});

describe("stale Gateway process-group escalation", () => {
  const starts = new Map<number, number | null>();
  const dead = new Set<number>();
  const kill = vi.fn<typeof process.kill>();
  const wait = vi.fn<() => Promise<void>>();
  const leader = 5760;
  const child = 5761;
  const unrelated = 5762;
  let members: () => string;

  beforeEach(() => {
    vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockImplementation(
      (pid) => starts.get(pid) ?? null,
    );
    vi.spyOn(pidAlive, "isPidDefinitelyDead").mockImplementation(
      (pid) => dead.has(pid) || !starts.has(pid),
    );
    vi.spyOn(sleep, "sleep").mockImplementation(wait);
    starts.clear();
    dead.clear();
    starts.set(leader, 1000);
    starts.set(child, 1001);
    starts.set(unrelated, 1002);
    wait.mockReset();
    wait.mockResolvedValue(undefined);
    members = () => `${leader} ${leader}\n${child} ${leader}\n${unrelated} 1\n`;
    mocks.spawn.mockReset();
    mocks.spawn.mockImplementation((command: string, args: string[]) => {
      if (command === "ps" && args[0] === "-p") {
        return { status: 0, stdout: `${leader}\n` };
      }
      if (command === "ps" && args[0] === "-axo") {
        return { status: 0, stdout: members() };
      }
      throw new Error(`Unexpected process command: ${command}`);
    });
    kill.mockReset().mockImplementation((pid, signal) => {
      if (pid === -leader && signal === "SIGTERM") {
        // The child ignores TERM, and becomes reparented when the leader exits.
        starts.delete(leader);
      } else if (signal === "SIGKILL") {
        starts.delete(pid);
      }
      return true;
    });
    vi.spyOn(process, "kill").mockImplementation(kill);
  });

  it.each(["recorded owner", "missing start identity", "dead candidate"])(
    "does not signal a PID with %s",
    async (reason) => {
      if (reason === "recorded owner") {
        mocks.owner.mockReturnValue(recordedOwner(leader, "dead"));
      } else if (reason === "missing start identity") {
        starts.set(leader, null);
      } else {
        dead.add(leader);
      }
      await withMockedPlatform("darwin", async () => {
        expect(await terminateStaleGatewayPids([leader])).toEqual([]);
        expect(kill).not.toHaveBeenCalled();
        expect(wait).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["survivor", "capture-recycle", "grace-recycle", "new-owner"] as const)(
    "escalates only the original surviving group members: %s",
    async (scenario) => {
      if (scenario === "capture-recycle") {
        let snapshots = 0;
        members = () => {
          starts.set(child, 2000);
          return `${leader} ${leader}\n${child} ${++snapshots === 1 ? leader : 1}\n`;
        };
      } else if (scenario !== "survivor") {
        wait.mockImplementation(async () => {
          if (scenario === "grace-recycle") {
            starts.set(child, 2000);
          } else {
            mocks.owner.mockReturnValue(recordedOwner(unrelated, "live", false));
          }
        });
      }
      await withMockedPlatform("darwin", async () => {
        expect(await terminateStaleGatewayPids([leader])).toEqual([leader]);
        expect(starts.has(leader)).toBe(false);
        expect(starts.has(unrelated)).toBe(true);
        expect(starts.get(child)).toBe(
          scenario === "survivor" ? undefined : scenario === "new-owner" ? 1001 : 2000,
        );
        if (scenario === "survivor") {
          expect(kill).toHaveBeenCalledWith(child, "SIGKILL");
        } else {
          expect(kill).not.toHaveBeenCalledWith(child, "SIGKILL");
        }
      });
    },
  );
});
