import fs from "node:fs";
import path from "node:path";
import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as pidAlive from "../shared/pid-alive.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import * as sleep from "../utils/sleep.js";
import { readGatewayLockProcessCmdline } from "./gateway-lock-process.js";
import {
  findVerifiedGatewayListenerPidsOnPortSync,
  signalVerifiedGatewayPidSync,
} from "./gateway-processes.js";
import {
  cleanStaleGatewayProcessesSync,
  findGatewayPidsOnPortSync,
  terminateStaleGatewayPids,
} from "./restart-stale-pids.js";

const readProcessIdentity = vi.hoisted(() => vi.fn());
const readProcessAncestry = vi.hoisted(() =>
  vi.fn<typeof import("@openclaw/proc-safe/identity").readProcessAncestry>(),
);
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/identity")>()),
  readProcessAncestry,
  readProcessIdentity,
}));

const mockSpawnSync = vi.hoisted(() => vi.fn());
const mockResolveGatewayPort = vi.hoisted(() => vi.fn(() => 18789));
const mockRestartWarn = vi.hoisted(() => vi.fn());
const mockReadGatewayOwnerLease = vi.hoisted(() =>
  vi.fn<typeof import("./gateway-owner-lease.js").readGatewayOwnerLease>(),
);
const mockReadWindowsListeningPids = vi.hoisted(() =>
  vi.fn((_port: number, _timeoutMs?: number): number[] => []),
);
const mockReadWindowsListeningPidsResult = vi.hoisted(() =>
  vi.fn<(_port: number, _timeoutMs?: number) => MockWindowsListeningPidsResult>(
    (_port: number, _timeoutMs?: number) => ({ ok: true, pids: [] }),
  ),
);
const mockReadWindowsProcessArgs = vi.hoisted(() =>
  vi.fn((_pid: number, _timeoutMs?: number): string[] | null => null),
);
const mockReadWindowsProcessArgsResult = vi.hoisted(() =>
  vi.fn<(_pid: number, _timeoutMs?: number) => MockWindowsProcessArgsResult>(
    (_pid: number, _timeoutMs?: number) => ({ ok: true, args: null }),
  ),
);
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockReadlinkSync = vi.hoisted(() => vi.fn());
const mockDarwinCommand = vi.hoisted(() => vi.fn());
const observedArgv = vi.hoisted(() => new Map<number, string[]>());

vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:fs")>("node:fs"),
    (actual) => ({
      readlinkSync: new Proxy(actual.readlinkSync, {
        apply: (_target, _receiver, args) => mockReadlinkSync(...args),
      }),
      readFileSync: ((pathname: unknown, encoding?: unknown) => {
        const pid = Number(/^\/proc\/(\d+)\/cmdline$/.exec(String(pathname))?.[1]);
        return observedArgv.get(pid)?.join("\0") ?? mockReadFileSync(pathname, encoding);
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
      spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
      execFileSync: vi.fn(),
    },
  );
});

vi.mock("../config/paths.js", () => ({
  resolveGatewayPort: () => mockResolveGatewayPort(),
}));

vi.mock("./ports-lsof.js", () => ({
  resolveLsofCommandSync: vi.fn(() => "lsof"),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: mockRestartWarn }),
}));

vi.mock("../process/supervisor/darwin-process-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/supervisor/darwin-process-command.js")>()),
  readDarwinProcessCommand: mockDarwinCommand,
}));

vi.mock("./gateway-owner-lease.js", () => ({
  readGatewayOwnerLease: mockReadGatewayOwnerLease,
}));

vi.mock("./windows-port-pids.js", () => ({
  readWindowsListeningPidsOnPortSync: mockReadWindowsListeningPids,
  readWindowsListeningPidsResultSync: mockReadWindowsListeningPidsResult,
  readWindowsProcessArgsSync: mockReadWindowsProcessArgs,
  readWindowsProcessArgsResultSync: mockReadWindowsProcessArgsResult,
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
    observedArgv.set(pid, ["openclaw-gateway"]);
  }
  return pids.map((pid) => `p${pid}\ncopenclaw-gateway\n`).join("");
}

function processIdentity(pid: number, parentPid: number) {
  return { pid, parentPid, startTimeMicros: 100, startTimeResolutionMicros: 1, exited: false };
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

type MockWindowsProcessArgsResult =
  | { ok: true; args: string[] | null }
  | { ok: false; permanent: boolean };

function createLsofResult(overrides: Partial<MockLsofResult> = {}): MockLsofResult {
  return {
    error: null,
    status: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

function createOpenClawBusyResult(pid: number) {
  return createLsofResult({ stdout: gatewayLsofOutput([pid]) });
}

function createErrnoResult(code: string, message: string) {
  return createLsofResult({ error: Object.assign(new Error(message), { code }), status: null });
}

function installInitialBusyPoll(
  stalePids: number | number[],
  resolvePoll: (call: number) => MockLsofResult = () => createLsofResult({ status: 1 }),
): () => number {
  let call = 0;
  mockSpawnSync.mockImplementation((command: unknown) => {
    if (command !== "lsof") {
      return createLsofResult();
    }
    call += 1;
    if (call === 1) {
      return createLsofResult({
        stdout: gatewayLsofOutput(typeof stalePids === "number" ? [stalePids] : stalePids),
      });
    }
    return resolvePoll(call);
  });
  return () => call;
}

function mockWindowsPoll(initial: MockWindowsListeningPidsResult, poll = initial): void {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mockReadWindowsListeningPidsResult.mockImplementation((_port, timeoutMs) => {
    if (timeoutMs === 400) {
      now += 2001;
      return poll;
    }
    return initial;
  });
}

function expectWarningContaining(text: string): void {
  expect(mockRestartWarn).toHaveBeenCalledWith(expect.stringContaining(text));
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
  readProcessAncestry.mockReset().mockReturnValue(null);
  // These liveness fixtures drive process.kill independently of a native process table.
  readProcessIdentity.mockReset().mockImplementation(() => {
    throw new ProcSafeError("helper-unavailable", "fixture uses signal probes");
  });
  mockSpawnSync.mockReset();
  observedArgv.clear();
  mockReadlinkSync.mockReset().mockImplementation(actualFs.readlinkSync);
  mockDarwinCommand.mockReset().mockImplementation((pid: number) => {
    const argv = observedArgv.get(pid);
    return argv ? { argv } : undefined;
  });
  mockReadGatewayOwnerLease.mockReset().mockReturnValue(undefined);
  mockResolveGatewayPort.mockReset().mockReturnValue(18789);
  mockRestartWarn.mockReset();
  mockReadWindowsListeningPids.mockReset().mockReturnValue([]);
  mockReadWindowsListeningPidsResult.mockReset().mockReturnValue({ ok: true, pids: [] });
  mockReadWindowsProcessArgs.mockReset().mockReturnValue(null);
  mockReadWindowsProcessArgsResult.mockReset().mockReturnValue({ ok: true, args: null });
  mockReadFileSync.mockReset().mockImplementation(() => {
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
    [createLsofResult({ status: 1 }), null],
    [createLsofResult({ status: 2, stderr: "lsof error" }), "lsof exited with status 2"],
    [createErrnoResult("ENOENT", "lsof not found"), null],
    [
      createErrnoResult("EACCES", "permission denied"),
      "lsof failed during initial stale-pid scan for port 18789: EACCES",
    ],
    [
      createLsofResult({ error: new Error("lsof unavailable"), status: null }),
      "lsof failed during initial stale-pid scan for port 18789: lsof unavailable",
    ],
  ] as const)("handles failed initial scan %j", (result, warning) => {
    mockSpawnSync.mockReturnValue(result);
    expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([]);
    if (warning) {
      expectWarningContaining(warning);
    } else {
      expect(mockRestartWarn).not.toHaveBeenCalled();
    }
  });

  it.each(["linux", "darwin", "freebsd", "win32"] as const)(
    "excludes the native ancestor chain on %s",
    (platform) => {
      const parentPid = process.pid + 2003;
      const grandparentPid = process.pid + 2004;
      const stalePid = process.pid + 2005;
      readProcessAncestry.mockReturnValue({
        chain: [
          processIdentity(process.pid, parentPid),
          processIdentity(parentPid, grandparentPid),
          processIdentity(grandparentPid, 1),
        ],
        complete: true,
        stoppedBy: "root",
      });
      const output = gatewayLsofOutput([parentPid, grandparentPid, stalePid]);
      mockSpawnSync.mockImplementation((command: string) =>
        createLsofResult({ stdout: command === "ps" ? "openclaw gateway" : output }),
      );
      mockReadWindowsListeningPids.mockReturnValue([parentPid, grandparentPid, stalePid]);
      mockReadWindowsProcessArgs.mockReturnValue(["openclaw", "gateway"]);
      withMockedPlatform(platform, () => {
        const pids = withStubbedPpid(parentPid, () => findGatewayPidsOnPortSync(18789));
        expect(pids).toEqual([stalePid]);
      });
      expect(readProcessAncestry).toHaveBeenCalledWith(process.pid, { maxDepth: 34 });
    },
  );

  it("protects an unreadable transitive parent without treating its identity as verified", async () => {
    const { inspectSelfAndAncestorPidsSync } = await import("./restart-stale-pids.js");
    const parentPid = process.pid + 2003;
    const unknownPid = process.pid + 2004;
    readProcessAncestry.mockReturnValue({
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

  it("excludes ancestor pids on Windows too — #68451 regression mirror for the win32 path", () => {
    const parentGatewayPid = process.pid + 2101;
    const unrelatedStalePid = process.pid + 2102;
    withMockedPlatform("win32", () => {
      mockReadWindowsListeningPids.mockReturnValue([parentGatewayPid, unrelatedStalePid]);
      mockReadWindowsProcessArgs.mockReturnValue(["openclaw", "gateway"]);
      const pids = withStubbedPpid(parentGatewayPid, () => findGatewayPidsOnPortSync(18789));
      expect(pids).not.toContain(parentGatewayPid);
      expect(pids).toContain(unrelatedStalePid);
      expect(mockReadWindowsProcessArgs).not.toHaveBeenCalledWith(parentGatewayPid);
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
    observedArgv.set(second, ["openclaw", "gateway"]);
    observedArgv.set(foreign, ["python", "server.py"]);
    mockSpawnSync.mockImplementation(
      (command: unknown, _args: unknown, options: { timeout?: number }) => {
        if (command !== "lsof") {
          return createLsofResult();
        }
        return (options.timeout ?? 0) >= 3000
          ? createLsofResult({ stdout })
          : createErrnoResult("ETIMEDOUT", "lsof timed out");
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
      () => createLsofResult({ error: new Error("timeout"), status: null }),
      () => createLsofResult({ status: 2, stderr: "permission denied" }),
      () => createLsofResult({ stdout: "p111abc\ncopenclaw-gateway\n" }),
      () => createLsofResult({ status: 1, stdout: "p123\nccaddy\n" }),
      () => createLsofResult({ status: 1 }),
    ];
    const calls = installInitialBusyPoll(stalePid, (call) => polls[call - 2]!());
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    expect(cleanStaleGatewayProcessesSync(19999)).toEqual([stalePid]);
    expect(mockResolveGatewayPort).not.toHaveBeenCalled();
    expect(mockSpawnSync).toHaveBeenNthCalledWith(
      1,
      "lsof",
      ["-nP", "-iTCP:19999", "-sTCP:LISTEN", "-Fpc"],
      expect.objectContaining({ encoding: "utf8", timeout: 5000 }),
    );
    expect(calls()).toBe(1 + polls.length);
    expect(kill).toHaveBeenCalledWith(stalePid, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(stalePid, "SIGKILL");
  });

  it.each([
    { platform: "darwin", boundary: "before scan" },
    { platform: "darwin", boundary: "after scan" },
    { platform: "darwin", boundary: "before escalation" },
    { platform: "win32", boundary: "before escalation" },
  ] as const)("protects a recorded owner $boundary on $platform", ({ platform, boundary }) => {
    const pid = process.pid + 7100;
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-synchronous-cleanup" };
    const events: string[] = [];
    let ownerAvailable = boundary === "before scan";
    let scanned = false;
    mockReadGatewayOwnerLease.mockImplementation((params) =>
      ownerAvailable && params?.env?.OPENCLAW_STATE_DIR === env.OPENCLAW_STATE_DIR
        ? recordedOwner(pid)
        : undefined,
    );
    const scan = () => {
      if (scanned) {
        return false;
      }
      scanned = true;
      events.push("scan");
      if (boundary === "after scan") {
        ownerAvailable = true;
      }
      return true;
    };
    const recordSignal = (signal: string) => {
      events.push(signal);
      if (signal === "SIGTERM" && boundary === "before escalation") {
        ownerAvailable = true;
      }
    };
    mockSpawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === "lsof") {
        return scan() ? createOpenClawBusyResult(pid) : createLsofResult({ status: 1 });
      }
      if (command.endsWith("taskkill.exe")) {
        recordSignal(args.includes("/F") ? "SIGKILL" : "SIGTERM");
      }
      return createLsofResult();
    });
    mockReadWindowsListeningPidsResult.mockImplementation(() => ({
      ok: true,
      pids: scan() ? [pid] : [],
    }));
    mockReadWindowsProcessArgsResult.mockReturnValue({ ok: true, args: ["openclaw", "gateway"] });
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (typeof signal === "string") {
        recordSignal(signal);
      }
      return true;
    });

    withMockedPlatform(platform, () =>
      withStubbedPpid(0, () => cleanStaleGatewayProcessesSync(18789, { env })),
    );

    expect(events).toEqual(
      boundary === "before scan" ? [] : boundary === "after scan" ? ["scan"] : ["scan", "SIGTERM"],
    );
  });
  it.each(["after inspection", "before escalation"] as const)(
    "rechecks signal authority %s",
    (boundary) => {
      const stalePid = process.pid + 100;
      installInitialBusyPoll(stalePid, () => createLsofResult({ status: 1 }));
      let current = boundary !== "after inspection";
      const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
        if (signal === "SIGTERM") {
          current = false;
        }
        return true;
      });
      cleanStaleGatewayProcessesSync(18789, {
        assertCurrent: () => {
          if (!current) {
            throw new Error("update owner revoked");
          }
        },
      });
      expect(killSpy).not.toHaveBeenCalledWith(stalePid, "SIGKILL");
      if (boundary === "after inspection") {
        expect(killSpy).not.toHaveBeenCalled();
      } else {
        expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
      }
    },
  );
  it("continues cleanup and port polling when individual process signals fail", () => {
    const termDeniedPid = process.pid + 198;
    const killDeniedPid = process.pid + 199;
    const calls = installInitialBusyPoll([termDeniedPid, killDeniedPid]);

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

  it("does not kill a protected gateway pid after reparenting", () => {
    const protectedPid = process.pid + 4001;
    const stalePid = process.pid + 4002;
    installInitialBusyPoll([1, protectedPid, stalePid]);
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    const result = withStubbedPpid(1, () =>
      cleanStaleGatewayProcessesSync(18789, { protectedPid }),
    );

    expect(result).toEqual([stalePid]);
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(protectedPid, expect.anything());
    expect(killSpy).not.toHaveBeenCalledWith(1, expect.anything());
  });

  it("refreshes the protected pid after listener enumeration before filtering", () => {
    const oldManagedPid = process.pid + 4100;
    const replacementPid = process.pid + 4101;
    const stalePid = process.pid + 4102;
    let listenerSnapshotCaptured = false;
    let lsofCall = 0;
    mockSpawnSync.mockImplementation((command: unknown) => {
      if (command !== "lsof") {
        return createLsofResult({ status: 1 });
      }
      lsofCall += 1;
      if (lsofCall === 1) {
        listenerSnapshotCaptured = true;
        return createLsofResult({
          stdout: gatewayLsofOutput([replacementPid, stalePid]),
        });
      }
      return createLsofResult({ status: 1 });
    });
    const resolveProtectedPid = vi.fn(() => {
      expect(listenerSnapshotCaptured).toBe(true);
      return replacementPid;
    });
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    const result = withStubbedPpid(0, () =>
      cleanStaleGatewayProcessesSync(18789, {
        protectedPid: oldManagedPid,
        resolveProtectedPid,
      }),
    );

    expect(result).toEqual([stalePid]);
    expect(resolveProtectedPid).toHaveBeenCalledOnce();
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(replacementPid, expect.anything());
    expect(killSpy).not.toHaveBeenCalledWith(oldManagedPid, expect.anything());
  });

  it("reports the raw owner lease read failure without scanning or signaling processes", () => {
    const cause =
      "EACCES: permission denied reading gateway owner lease password=synthetic-review-only-abcdefghijk";
    mockReadGatewayOwnerLease.mockImplementationOnce(() => {
      throw new Error(cause);
    });
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    expect(cleanStaleGatewayProcessesSync(18789)).toEqual([]);
    expectWarningContaining("stale gateway process cleanup failed:");
    expectWarningContaining(cause);
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("fails closed when the refreshed protected pid cannot be resolved", () => {
    const listenerPid = process.pid + 4301;
    mockSpawnSync.mockReturnValue(createOpenClawBusyResult(listenerPid));
    const resolveProtectedPid = vi.fn(() => {
      throw new Error("launchctl print failed");
    });
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    const result = withStubbedPpid(0, () =>
      cleanStaleGatewayProcessesSync(18789, { resolveProtectedPid }),
    );

    expect(result).toEqual([]);
    expect(resolveProtectedPid).toHaveBeenCalledOnce();
    expectWarningContaining("launchctl print failed");
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("stops polling after permanent EPERM", () => {
    const stalePid = process.pid + 300;
    const calls = installInitialBusyPoll(stalePid, () => createErrnoResult("EPERM", "unavailable"));
    vi.spyOn(process, "kill").mockReturnValue(true);
    expect(cleanStaleGatewayProcessesSync()).toEqual([stalePid]);
    expect(calls()).toBe(2);
  });

  it("still polls when stale pids exit before SIGTERM", () => {
    const stalePid = process.pid + 304;
    const calls = installInitialBusyPoll(stalePid, () => createLsofResult({ status: 1 }));
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    expect(cleanStaleGatewayProcessesSync()).toEqual([]);
    expect(calls()).toBe(2);
  });

  it("does not force-kill a stale PID that canonical liveness reports dead", () => {
    const stalePid = process.pid + 499;
    installInitialBusyPoll(stalePid);
    vi.spyOn(pidAlive, "isPidAlive").mockReturnValue(false);
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    expect(cleanStaleGatewayProcessesSync(18789)).toStrictEqual([stalePid]);
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(stalePid, "SIGKILL");
  });

  it("treats failed Windows port probes as inconclusive, not free", () => {
    const stalePid = process.pid + 910;
    withMockedPlatform("win32", () => {
      mockReadWindowsProcessArgsResult.mockReturnValue({
        ok: true,
        args: ["openclaw", "gateway"],
      });
      mockSpawnSync.mockReturnValue(createLsofResult());
      mockWindowsPoll({ ok: true, pids: [stalePid] }, { ok: false, permanent: false });
      let aliveChecks = 0;
      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (signal === 0 && pid === stalePid) {
          aliveChecks += 1;
          if (aliveChecks < 3) {
            return true;
          }
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        return true;
      });

      expect(cleanStaleGatewayProcessesSync()).toEqual([stalePid]);
      expect(mockReadWindowsListeningPidsResult).toHaveBeenCalledWith(18789, 400);
      expectWarningContaining("port 18789 still in use after 2000ms");
      expect(killSpy).toHaveBeenCalledWith(stalePid, 0);
    });
  });

  it.each(["listener scan", "argv inspection"])(
    "waits for port release when Windows %s is inconclusive",
    (stage) => {
      const stalePid = process.pid + 913;
      withMockedPlatform("win32", () => {
        mockWindowsPoll(
          stage === "listener scan"
            ? { ok: false, permanent: false }
            : { ok: true, pids: [stalePid] },
        );
        mockReadWindowsProcessArgsResult.mockReturnValue({ ok: false, permanent: false });
        const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
        expect(cleanStaleGatewayProcessesSync()).toStrictEqual([]);
        expect(mockReadWindowsListeningPidsResult).toHaveBeenCalledWith(18789, 400);
        if (stage === "argv inspection") {
          expect(mockReadWindowsProcessArgsResult).toHaveBeenCalledWith(stalePid);
        }
        expectWarningContaining("port 18789 still in use after 2000ms");
        expect(killSpy).not.toHaveBeenCalled();
      });
    },
  );
  it("treats Windows EPERM liveness checks as alive and still forces taskkill", () => {
    const stalePid = process.pid + 912;
    vi.stubEnv("SystemRoot", "C:\\PoisonedWindows");
    withMockedPlatform("win32", () => {
      let fakeNow = 0;
      vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
      mockReadWindowsListeningPidsResult.mockReturnValue({ ok: true, pids: [stalePid] });
      mockReadWindowsProcessArgsResult.mockReturnValue({
        ok: true,
        args: ["openclaw", "gateway"],
      });
      mockSpawnSync.mockImplementation((command: string) => {
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
      expect(
        mockSpawnSync.mock.calls.filter(
          (call) => call[0] === "C:\\Windows\\System32\\taskkill.exe",
        ),
      ).toEqual(
        [
          ["/T", "/PID", String(stalePid)],
          ["/F", "/T", "/PID", String(stalePid)],
        ].map((args) => [
          "C:\\Windows\\System32\\taskkill.exe",
          args,
          { stdio: "ignore", timeout: 5000, windowsHide: true },
        ]),
      );
    });
  });
});

it("reports an unclassified Windows listener without reclaiming its process", () => {
  const pid = process.pid + 901;
  mockReadWindowsListeningPidsResult.mockReturnValue({ ok: true, pids: [pid] });
  mockReadWindowsProcessArgsResult.mockReturnValue({
    ok: true,
    args: ["node", "dist/index.js", "gateway"],
  });
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  withMockedPlatform("win32", () => {
    expect(cleanStaleGatewayProcessesSync(18789)).toEqual([]);
  });
  expect(mockRestartWarn).toHaveBeenCalledWith(
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
    const directories = new Map<number, string>();
    mockDarwinCommand.mockReturnValue({ argv: ["node", "dist/index.js", "gateway"] });
    for (const [pid, name] of [
      [ownedPid, "openclaw"],
      [unrelatedPid, "other-service"],
    ] as const) {
      const directory = path.join(
        root,
        platform === "darwin" && process.platform !== "win32"
          ? `${pid}\nworking directory`
          : String(pid),
      );
      fs.mkdirSync(path.join(directory, "dist"), { recursive: true });
      fs.writeFileSync(path.join(directory, "dist", "index.js"), "");
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name }));
      directories.set(pid, directory);
    }
    mockReadFileSync.mockImplementation((file: string) => {
      if (/^\/proc\/\d+\/cmdline$/.test(file)) {
        return "node\0dist/index.js\0gateway\0";
      }
      if (file.startsWith("/proc/")) {
        throw Object.assign(new Error("ancestor unavailable"), { code: "ENOENT" });
      }
      return actualFs.readFileSync(file, "utf8");
    });
    mockReadlinkSync.mockImplementation((file: unknown) => {
      const pid = Number(/^\/proc\/(\d+)\/cwd$/.exec(String(file))?.[1]);
      const directory = directories.get(pid);
      if (!directory) {
        throw Object.assign(new Error("working directory unavailable"), { code: "EACCES" });
      }
      return directory;
    });
    mockSpawnSync.mockImplementation((command: string, args: string[]) => {
      const result = { error: null, status: 0, stdout: "", stderr: "" };
      if (command === "lsof") {
        return {
          ...result,
          stdout: [ownedPid, unrelatedPid, unknownPid].map((pid) => `p${pid}\ncnode\n`).join(""),
        };
      }
      if (command === "/usr/sbin/lsof") {
        const pid = Number(args[2]);
        const directory = directories.get(pid);
        return directory
          ? { ...result, stdout: `p${pid}\0\nfcwd\0n${directory}\0\n` }
          : { ...result, status: 1 };
      }
      return { ...result, stdout: args[0] === "-ww" ? "node dist/index.js gateway\n" : "" };
    });
    withMockedPlatform(platform, () => {
      expect(findGatewayPidsOnPortSync(18789)).toEqual([ownedPid]);
    });
  },
);

it.each([
  { platform: "darwin", packageName: "openclaw", command: "node", verified: true },
  {
    platform: "darwin",
    packageName: "unrelated-indexer",
    command: "openclaw-indexer",
    verified: false,
  },
  { platform: "linux", packageName: "openclaw", command: "node", verified: true },
] as const)(
  "classifies the $platform $command listener from argv and package ownership",
  async ({ platform, packageName, command, verified }) => {
    const root = path.join(tempDirs.make("gateway-native-argv-"), "application with spaces");
    const script = path.join(root, "dist", "index.js");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: packageName }));
    const pid = process.pid + 701;
    const argv = ["node", script, "gateway"];
    mockReadFileSync.mockImplementation((file: string) => {
      if (platform === "linux" && file.startsWith("/proc/")) {
        throw Object.assign(new Error("procfs unavailable"), { code: "ENOENT" });
      }
      return actualFs.readFileSync(file, "utf8");
    });
    mockDarwinCommand.mockReturnValue({ argv });
    mockSpawnSync.mockImplementation((executable: string, args: string[]) => ({
      error: null,
      status: 0,
      stderr: "",
      stdout:
        executable === "lsof"
          ? `${platform === "linux" ? "p111abc\ncnode\n" : ""}p${pid}\nc${command}\n`
          : platform === "linux" && args[0] === "-ww"
            ? `node "${script}" gateway\n`
            : "",
    }));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    withMockedPlatform(platform, () => {
      expect(findGatewayPidsOnPortSync(18789)).toEqual(verified ? [pid] : []);
      if (platform !== "darwin") {
        return;
      }
      expect(findVerifiedGatewayListenerPidsOnPortSync(18789)).toEqual(verified ? [pid] : []);
      if (verified) {
        signalVerifiedGatewayPidSync(pid, "SIGTERM");
        expect(kill).toHaveBeenCalledWith(pid, "SIGTERM");
      } else {
        expect(() => signalVerifiedGatewayPidSync(pid, "SIGTERM")).toThrow(
          "refusing to signal non-gateway process",
        );
        expect(kill).not.toHaveBeenCalled();
      }
      expect(readGatewayLockProcessCmdline(pid, "darwin", 1000)).toEqual(argv);
    });
    if (platform === "linux") {
      const psCall = mockSpawnSync.mock.calls.find(
        (call) => call[0] === "ps" && call[1]?.[0] === "-ww",
      );
      expect(psCall?.[1]).toEqual(["-ww", "-p", String(pid), "-o", "command="]);
      expect(psCall?.[2]).toEqual({
        env: expect.any(Object),
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout: 2000,
      });
    }
  },
);

describe("stale Gateway process-group escalation", () => {
  const starts = new Map<number, number | null>();
  const dead = new Set<number>();
  const kill = vi.fn<typeof process.kill>();
  const wait = vi.fn<() => Promise<void>>();
  const leader = 5760;
  const child = 5761;
  const unrelated = 5762;

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
    mockSpawnSync.mockReset();
    mockSpawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === "ps" && args[0] === "-p") {
        return { status: 0, stdout: `${leader}\n` };
      }
      if (command === "ps" && args[0] === "-axo") {
        return { status: 0, stdout: `${leader} ${leader}\n${child} ${leader}\n${unrelated} 1\n` };
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
        mockReadGatewayOwnerLease.mockReturnValue(recordedOwner(leader, "dead"));
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

  it("kills a surviving child after the group leader exits on SIGTERM", async () => {
    await withMockedPlatform("darwin", async () => {
      expect(await terminateStaleGatewayPids([leader])).toEqual([leader]);
      expect(starts.has(leader)).toBe(false);
      expect(starts.has(child)).toBe(false);
      expect(starts.has(unrelated)).toBe(true);
      expect(kill).toHaveBeenCalledWith(child, "SIGKILL");
    });
  });

  it("does not adopt a child PID recycled outside the group during identity capture", async () => {
    let snapshots = 0;
    mockSpawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === "ps" && args[0] === "-p") {
        return { status: 0, stdout: `${leader}\n` };
      }
      if (command === "ps" && args[0] === "-axo") {
        snapshots += 1;
        starts.set(child, 2000);
        return {
          status: 0,
          stdout: `${leader} ${leader}\n${child} ${snapshots === 1 ? leader : 1}\n`,
        };
      }
      throw new Error(`Unexpected process command: ${command}`);
    });
    await withMockedPlatform("darwin", async () => {
      expect(await terminateStaleGatewayPids([leader])).toEqual([leader]);
      expect(starts.get(child)).toBe(2000);
      expect(kill).not.toHaveBeenCalledWith(child, "SIGKILL");
    });
  });

  it.each(["recycled-child", "replacement-owner"])(
    "preserves a captured child after %s appears during the TERM grace period",
    async (replacement) => {
      wait.mockImplementation(async () => {
        if (replacement === "recycled-child") {
          starts.set(child, 2000);
        } else {
          mockReadGatewayOwnerLease.mockReturnValue(recordedOwner(unrelated, "live", false));
        }
      });
      await withMockedPlatform("darwin", async () => {
        expect(await terminateStaleGatewayPids([leader])).toEqual([leader]);
        expect(starts.has(child)).toBe(true);
        expect(kill).not.toHaveBeenCalledWith(child, "SIGKILL");
      });
    },
  );
});
