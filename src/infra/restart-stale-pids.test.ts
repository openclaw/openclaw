import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";

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
const observedArgv = vi.hoisted(() => new Map<number, string[]>());

vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:fs")>("node:fs"),
    (actual) => ({
      readFileSync: ((path: unknown, encoding?: unknown) => {
        const pid = Number(/^\/proc\/(\d+)\/cmdline$/.exec(String(path))?.[1]);
        return observedArgv.get(pid)?.join("\0") ?? mockReadFileSync(path, encoding);
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

vi.mock("../process/supervisor/darwin-process-command.js", () => ({
  readDarwinProcessCommand: (pid: number) => {
    const argv = observedArgv.get(pid);
    return argv ? { argv } : undefined;
  },
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

let cleanStaleGatewayProcessesSync: typeof import("./restart-stale-pids.js").cleanStaleGatewayProcessesSync;
let findGatewayPidsOnPortSync: typeof import("./restart-stale-pids.js").findGatewayPidsOnPortSync;

function gatewayLsofOutput(pids: number[]): string {
  for (const pid of pids) {
    observedArgv.set(pid, ["openclaw-gateway"]);
  }
  return pids.map((pid) => `p${pid}\ncopenclaw-gateway\n`).join("");
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
  stalePid: number,
  resolvePoll: (call: number) => MockLsofResult,
): () => number {
  let call = 0;
  mockSpawnSync.mockImplementation((command: unknown) => {
    if (command !== "lsof") {
      return createLsofResult();
    }
    call += 1;
    if (call === 1) {
      return createOpenClawBusyResult(stalePid);
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

describe.skipIf(process.platform === "win32")("restart-stale-pids", () => {
  beforeAll(async () => {
    ({ cleanStaleGatewayProcessesSync, findGatewayPidsOnPortSync } =
      await import("./restart-stale-pids.js"));
  });

  beforeEach(() => {
    mockSpawnSync.mockReset();
    observedArgv.clear();
    mockReadGatewayOwnerLease.mockReset();
    mockReadGatewayOwnerLease.mockReturnValue(undefined);
    mockResolveGatewayPort.mockReset();
    mockRestartWarn.mockReset();
    mockReadWindowsListeningPids.mockReset();
    mockReadWindowsListeningPidsResult.mockReset();
    mockReadWindowsProcessArgs.mockReset();
    mockReadWindowsProcessArgsResult.mockReset();
    mockReadFileSync.mockReset();
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: test default"), { code: "ENOENT" });
    });
    mockResolveGatewayPort.mockReturnValue(18789);
    mockReadWindowsListeningPids.mockReturnValue([]);
    mockReadWindowsListeningPidsResult.mockReturnValue({ ok: true, pids: [] });
    mockReadWindowsProcessArgs.mockReturnValue(null);
    mockReadWindowsProcessArgsResult.mockReturnValue({ ok: true, args: null });
    vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

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

  it("returns [] when lsof exits with non-zero status", () => {
    mockSpawnSync.mockReturnValue(createLsofResult({ status: 1 }));
    expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([]);
  });

  it("logs warning when initial lsof scan exits with status > 1", () => {
    mockSpawnSync.mockReturnValue(createLsofResult({ status: 2, stderr: "lsof error" }));
    expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([]);
    expectWarningContaining("lsof exited with status 2");
  });

  it("silently skips the initial scan when lsof is missing", () => {
    mockSpawnSync.mockReturnValue(createErrnoResult("ENOENT", "lsof not found"));
    expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([]);
    expect(mockRestartWarn).not.toHaveBeenCalled();
  });

  it.each([
    [Object.assign(new Error("permission denied"), { code: "EACCES" }), "EACCES"],
    [new Error("lsof unavailable"), "lsof unavailable"],
  ] as const)("warns when the initial scan fails: %s", (error, detail) => {
    mockSpawnSync.mockReturnValue(createLsofResult({ error, status: null }));
    expect(findGatewayPidsOnPortSync(18789)).toEqual([]);
    expectWarningContaining(`lsof failed during initial stale-pid scan for port 18789: ${detail}`);
  });

  it("finds stale pids when lsof needs seconds to answer", () => {
    const slowLsofMs = 3000;
    const stalePid = process.pid + 105;
    mockSpawnSync.mockImplementation((command: unknown, _args: unknown, options: unknown) => {
      if (command !== "lsof") {
        return createLsofResult();
      }
      const timeout = (options as { timeout?: number }).timeout ?? 0;
      return timeout >= slowLsofMs
        ? createOpenClawBusyResult(stalePid)
        : createErrnoResult("ETIMEDOUT", "lsof timed out");
    });
    expect(findGatewayPidsOnPortSync(18789)).toStrictEqual([stalePid]);
  });
  it.skipIf(process.platform !== "linux")(
    "excludes the full ancestor chain, not just the direct parent — deeper nesting",
    () => {
      const directParentPid = process.pid + 2003;
      const grandparentPid = process.pid + 2004;
      const benignStalePid = process.pid + 2005;
      mockReadFileSync.mockImplementation((path: unknown): string => {
        if (path === `/proc/${directParentPid}/status`) {
          return `Name:\topenclaw-gateway\nPid:\t${directParentPid}\nPPid:\t${grandparentPid}\n`;
        }
        if (path === `/proc/${grandparentPid}/status`) {
          return `Name:\tsystemd\nPid:\t${grandparentPid}\nPPid:\t0\n`;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      mockSpawnSync.mockReturnValue(
        createLsofResult({
          stdout: gatewayLsofOutput([directParentPid, grandparentPid, benignStalePid]),
        }),
      );
      const pids = withStubbedPpid(directParentPid, () => findGatewayPidsOnPortSync(18789));
      expect(pids).not.toContain(directParentPid);
      expect(pids).not.toContain(grandparentPid);
      expect(pids).toContain(benignStalePid);
    },
  );

  it("excludes PID 1 when the direct parent gateway is the container entrypoint — container topology", () => {
    const benignStalePid = process.pid + 2050;
    mockSpawnSync.mockReturnValue(
      createLsofResult({ stdout: gatewayLsofOutput([1, benignStalePid]) }),
    );
    const pids = withStubbedPpid(1, () => findGatewayPidsOnPortSync(18789));
    expect(pids).not.toContain(1);
    expect(pids).toContain(benignStalePid);
  });

  it("excludes the full ancestor chain on macOS via ps - nested in-band updater regression for #85120", () => {
    const toolHostPid = process.pid + 3101;
    const gatewayGrandparentPid = process.pid + 3102;
    const benignStalePid = process.pid + 3103;
    withMockedPlatform("darwin", () => {
      mockSpawnSync.mockImplementation((command: unknown, args: unknown) => {
        if (command === "ps" && Array.isArray(args) && args[0] === "-o") {
          const targetPid = args[3];
          if (targetPid === String(toolHostPid)) {
            return createLsofResult({ stdout: `${gatewayGrandparentPid}\n` });
          }
          if (targetPid === String(gatewayGrandparentPid)) {
            return createLsofResult({ stdout: "1\n" });
          }
          return createLsofResult({ stdout: "0\n" });
        }
        return createLsofResult({
          stdout: gatewayLsofOutput([toolHostPid, gatewayGrandparentPid, benignStalePid]),
        });
      });

      const pids = withStubbedPpid(toolHostPid, () => findGatewayPidsOnPortSync(18789));
      expect(pids).not.toContain(toolHostPid);
      expect(pids).not.toContain(gatewayGrandparentPid);
      expect(pids).toContain(benignStalePid);
    });
  });
  it("uses the explicit timeout for macOS ancestor ps probes", () => {
    const gatewayParentPid = process.pid + 3151;
    withMockedPlatform("darwin", () => {
      mockSpawnSync.mockImplementation((command: unknown, args: unknown) => {
        if (command === "ps" && Array.isArray(args) && args[0] === "-o") {
          return createLsofResult({ stdout: "1\n" });
        }
        return createLsofResult({ stdout: gatewayLsofOutput([process.pid + 3152]) });
      });

      withStubbedPpid(gatewayParentPid, () => findGatewayPidsOnPortSync(18789, 400));
      const ancestorPsCall = mockSpawnSync.mock.calls.find(
        (call) => call[0] === "ps" && Array.isArray(call[1]) && (call[1] as unknown[])[0] === "-o",
      );
      expect(ancestorPsCall?.[2]).toEqual({
        env: expect.any(Object),
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout: 400,
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
    const stdout = `p0\ncopenclaw-gateway\np${unknown}\nf8\n${gatewayLsofOutput([
      first,
      process.pid,
      second,
      first,
    ])}`;
    mockSpawnSync.mockReturnValue(createLsofResult({ stdout }));
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
    expect(cleanStaleGatewayProcessesSync()).toEqual([stalePid]);
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
        ? {
            owner: "gateway-owner",
            pid,
            host: "gateway-test-host",
            startedAt: 1000,
            port: 18789,
            mode: "supervised",
            supervisor: { kind: "schtasks", name: "OpenClaw Gateway" },
            state: "live",
            expired: true,
          }
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
    let lsofCall = 0;
    mockSpawnSync.mockImplementation((command: unknown) => {
      if (command !== "lsof") {
        return createLsofResult();
      }
      lsofCall += 1;
      return lsofCall === 1
        ? createLsofResult({
            stdout: gatewayLsofOutput([termDeniedPid, killDeniedPid]),
          })
        : createLsofResult({ status: 1 });
    });

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
    expect(lsofCall).toBe(2);
  });

  it("does not kill a protected gateway pid after reparenting", () => {
    const protectedPid = process.pid + 4001;
    const stalePid = process.pid + 4002;
    let lsofCall = 0;
    mockSpawnSync.mockImplementation(() => {
      lsofCall += 1;
      return lsofCall === 1
        ? createLsofResult({
            stdout: gatewayLsofOutput([protectedPid, stalePid]),
          })
        : createLsofResult({ status: 1 });
    });
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    const result = withStubbedPpid(1, () =>
      cleanStaleGatewayProcessesSync(18789, { protectedPid }),
    );

    expect(result).toEqual([stalePid]);
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(protectedPid, expect.anything());
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
    expect(killSpy).not.toHaveBeenCalled();
  });

  it.each(["ENOENT", "EACCES", "EPERM"])("stops polling after permanent %s", (code) => {
    const stalePid = process.pid + 300;
    const calls = installInitialBusyPoll(stalePid, () => createErrnoResult(code, "unavailable"));
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

  it("waits for port release when the initial Windows stale-pid probe is inconclusive", () => {
    withMockedPlatform("win32", () => {
      mockWindowsPoll({ ok: false, permanent: false });
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

      expect(cleanStaleGatewayProcessesSync()).toStrictEqual([]);
      expect(mockReadWindowsListeningPidsResult).toHaveBeenCalledWith(18789, 400);
      expectWarningContaining("port 18789 still in use after 2000ms");
      expect(killSpy).not.toHaveBeenCalled();
    });
  });

  it("waits for port release when Windows listener argv inspection is inconclusive", () => {
    const stalePid = process.pid + 913;
    withMockedPlatform("win32", () => {
      mockWindowsPoll({ ok: true, pids: [stalePid] });
      mockReadWindowsProcessArgsResult.mockReturnValue({ ok: false, permanent: false });
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

      expect(cleanStaleGatewayProcessesSync()).toStrictEqual([]);
      expect(mockReadWindowsProcessArgsResult).toHaveBeenCalledWith(stalePid);
      expectWarningContaining("port 18789 still in use after 2000ms");
      expect(killSpy).not.toHaveBeenCalled();
    });
  });
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
      ).toEqual([
        [
          "C:\\Windows\\System32\\taskkill.exe",
          ["/T", "/PID", String(stalePid)],
          { stdio: "ignore", timeout: 5000, windowsHide: true },
        ],
        [
          "C:\\Windows\\System32\\taskkill.exe",
          ["/F", "/T", "/PID", String(stalePid)],
          { stdio: "ignore", timeout: 5000, windowsHide: true },
        ],
      ]);
    });
  });
});
