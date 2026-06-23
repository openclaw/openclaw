// Measure Rpc Rtt tests cover measure rpc rtt script behavior.
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveWindowsTaskkillPath } from "../../scripts/lib/windows-taskkill.mjs";
import {
  assertRpcSmokeResponse,
  cleanupTempRoot,
  createGatewayClient,
  installGatewayParentCleanup,
  isGatewayProcessAlive,
  parseArgs,
  signalGatewayProcess,
  startGateway,
  stopGateway,
  summarizeRttSamples,
  waitForGatewayReady,
} from "../../scripts/measure-rpc-rtt.mjs";

function expectedTaskkillPath(): string {
  return resolveWindowsTaskkillPath();
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function withDefaultWindowsSystemRoot(run: () => void): void {
  const originalSystemRoot = process.env.SystemRoot;
  const originalWindir = process.env.WINDIR;
  try {
    process.env.SystemRoot = "C:\\Windows";
    delete process.env.WINDIR;
    run();
  } finally {
    restoreEnvValue("SystemRoot", originalSystemRoot);
    restoreEnvValue("WINDIR", originalWindir);
  }
}

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  closed = false;
  readyState = 0;
  sent: string[] = [];
  terminated = false;

  constructor(
    readonly url: string,
    readonly options: unknown,
  ) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(payload: string, callback?: (error?: Error) => void): void {
    this.sent.push(payload);
    callback?.();
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", 1000, "closed");
  }

  terminate(): void {
    this.terminated = true;
    this.close();
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), init);
}

describe("scripts/measure-rpc-rtt.mjs", () => {
  it("closes websocket clients that time out before opening", async () => {
    FakeWebSocket.instances = [];
    const client = createGatewayClient({
      WebSocket: FakeWebSocket,
      openTimeoutMs: 1,
      url: "ws://127.0.0.1:12345",
    });

    await expect(client.waitOpen()).rejects.toThrow("gateway websocket open timeout");
    expect(FakeWebSocket.instances[0]?.closed).toBe(true);
    expect(FakeWebSocket.instances[0]?.terminated).toBe(true);
  });

  it("rejects websocket closes before opening", async () => {
    FakeWebSocket.instances = [];
    const client = createGatewayClient({
      WebSocket: FakeWebSocket,
      openTimeoutMs: 10_000,
      url: "ws://127.0.0.1:12345",
    });

    const opened = client.waitOpen();
    FakeWebSocket.instances[0]?.emit("close", 1006, Buffer.from("bye"));

    await expect(opened).rejects.toThrow("closed before open (1006): bye");
    expect(FakeWebSocket.instances[0]?.closed).toBe(false);
  });

  it("rejects pending websocket requests when cleanup closes the client", async () => {
    FakeWebSocket.instances = [];
    const client = createGatewayClient({
      WebSocket: FakeWebSocket,
      url: "ws://127.0.0.1:12345",
    });
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("fake websocket was not created");
    }
    socket.readyState = FakeWebSocket.OPEN;

    const request = client.request("health", {}, 10_000);
    client.close();

    await expect(request).rejects.toThrow("gateway websocket client closed");
    expect(socket.closed).toBe(true);
  });

  it("clears pending websocket request timers when send throws synchronously", async () => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    const client = createGatewayClient({
      WebSocket: FakeWebSocket,
      url: "ws://127.0.0.1:12345",
    });
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("fake websocket was not created");
    }
    socket.readyState = FakeWebSocket.OPEN;
    socket.send = () => {
      throw new Error("socket closed during send");
    };

    await expect(client.request("health", {}, 10_000)).rejects.toThrow("socket closed during send");

    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it("parses bounded RPC RTT options strictly", () => {
    expect(
      parseArgs([
        "--output-dir",
        "/tmp/rpc-rtt",
        "--repo-root",
        "/repo",
        "--iterations",
        "3",
        "--methods",
        "health, config.get ",
      ]),
    ).toMatchObject({
      iterations: 3,
      methods: ["health", "config.get"],
      outputDir: "/tmp/rpc-rtt",
      repoRoot: "/repo",
    });

    expect(() => parseArgs(["--output-dir", "/tmp/rpc-rtt", "--iterations", "1e3"])).toThrow(
      "--iterations must be a positive integer.",
    );
    expect(() => parseArgs(["--output-dir", "/tmp/rpc-rtt", "--iterations", "0"])).toThrow(
      "--iterations must be a positive integer.",
    );
    expect(() => parseArgs(["--output-dir", "/tmp/rpc-rtt", "--methods"])).toThrow(
      "--methods requires a value.",
    );
    for (const value of ["--methods", "-h"]) {
      for (const flag of ["--output-dir", "--repo-root", "--iterations", "--methods"]) {
        expect(() => parseArgs([flag, value, "health"])).toThrow(`${flag} requires a value.`);
      }
    }
  });

  it("prints usage for help without requiring an output directory", () => {
    expect(parseArgs(["--help"])).toMatchObject({ help: true });
    expect(parseArgs(["-h"])).toMatchObject({ help: true });

    const result = spawnSync(process.execPath, ["scripts/measure-rpc-rtt.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node --import tsx scripts/measure-rpc-rtt.mjs");
    expect(result.stderr).toBe("");
  });

  it("does not publish zero-millisecond RPC RTT summaries", () => {
    expect(summarizeRttSamples([0, 0.1, 0.49])).toEqual({
      avgMs: 1,
      maxMs: 1,
      minMs: 1,
      p50Ms: 1,
      p95Ms: 1,
    });
    expect(summarizeRttSamples([1.4, 2.6])).toEqual({
      avgMs: 2,
      maxMs: 3,
      minMs: 1,
      p50Ms: 1,
      p95Ms: 3,
    });
  });

  it("rejects invalid RPC RTT summary samples", () => {
    expect(() => summarizeRttSamples([])).toThrow("RPC RTT measurement produced no samples.");
    expect(() => summarizeRttSamples([Number.NaN])).toThrow(
      "avgMs must be a non-negative finite duration.",
    );
    expect(() => summarizeRttSamples([-1])).toThrow(
      "avgMs must be a non-negative finite duration.",
    );
  });

  it("validates default RPC RTT smoke payloads", () => {
    expect(() =>
      assertRpcSmokeResponse("health", {
        ok: true,
        payload: {
          agents: [],
          channelOrder: [],
          channels: {},
          defaultAgentId: "codex",
          durationMs: 3,
          ok: true,
          sessions: { count: 0, path: "/state/sessions", recent: [] },
          ts: Date.now(),
        },
      }),
    ).not.toThrow();

    expect(() =>
      assertRpcSmokeResponse("config.get", {
        ok: true,
        payload: {
          config: {},
          exists: true,
          issues: [],
          legacyIssues: [],
          path: "/tmp/openclaw.json",
          resolved: {},
          runtimeConfig: {},
          sourceConfig: {},
          valid: true,
          warnings: [],
        },
      }),
    ).not.toThrow();

    expect(() => assertRpcSmokeResponse("health", { ok: true, payload: {} })).toThrow(
      "health returned invalid payload: expected ok=true.",
    );
    expect(() => assertRpcSmokeResponse("config.get", { ok: true, payload: {} })).toThrow(
      "config.get returned invalid payload: expected config path.",
    );
  });

  it("keeps custom RPC RTT methods on the generic ok/error contract", () => {
    expect(() => assertRpcSmokeResponse("custom.method", { ok: true })).not.toThrow();
    expect(() =>
      assertRpcSmokeResponse("custom.method", {
        error: { code: "bad_request" },
        ok: false,
      }),
    ).toThrow('custom.method failed: {"code":"bad_request"}');
  });

  it("closes parent gateway log handles after spawning", async () => {
    const repoRoot = "/repo";
    const tempRoot = "/tmp/rpc-rtt";
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      signalCode: null,
    });
    const stdout = { close: vi.fn().mockResolvedValue(undefined), fd: 41 };
    const stderr = { close: vi.fn().mockResolvedValue(undefined), fd: 42 };
    const openImpl = vi.fn().mockResolvedValueOnce(stdout).mockResolvedValueOnce(stderr);
    const spawnImpl = vi.fn().mockReturnValue(child);

    await expect(
      startGateway({
        configPath: "/tmp/openclaw.json",
        env: { PATH: "/bin" },
        openImpl,
        port: 23456,
        repoRoot,
        sourceEntryExists: () => true,
        spawnImpl,
        stderrPath: "/tmp/stderr.log",
        stdoutPath: "/tmp/stdout.log",
        tempRoot,
        token: "secret-token",
      }),
    ).resolves.toBe(child);

    expect(openImpl).toHaveBeenNthCalledWith(1, "/tmp/stdout.log", "w");
    expect(openImpl).toHaveBeenNthCalledWith(2, "/tmp/stderr.log", "w");
    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repoRoot, "src", "entry.ts"),
        "gateway",
        "run",
        "--port",
        "23456",
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      expect.objectContaining({
        cwd: repoRoot,
        detached: process.platform !== "win32",
        env: expect.objectContaining({
          HOME: path.join(tempRoot, "home"),
          OPENCLAW_CONFIG_PATH: "/tmp/openclaw.json",
          OPENCLAW_GATEWAY_TOKEN: "secret-token",
          OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
          PATH: "/bin",
        }),
        stdio: ["ignore", 41, 42],
      }),
    );
    expect(stdout.close).toHaveBeenCalledTimes(1);
    expect(stderr.close).toHaveBeenCalledTimes(1);
  });

  it("signals the gateway process group on POSIX so pnpm children do not leak", () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      pid: 12345,
      signalCode: null,
    });
    const kill = vi.fn(() => true);
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    expect(signalGatewayProcess(child, "SIGTERM", kill, { runTaskkill })).toBe(true);

    if (process.platform === "win32") {
      expect(runTaskkill).toHaveBeenCalledWith(expectedTaskkillPath(), ["/PID", "12345", "/T"], {
        stdio: "ignore",
      });
      expect(child.kill).not.toHaveBeenCalled();
    } else {
      expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it("signals Windows gateway process trees with taskkill", () => {
    withDefaultWindowsSystemRoot(() => {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        kill: vi.fn(),
        pid: 12345,
        signalCode: null,
      });
      const kill = vi.fn(() => true);
      const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

      expect(
        signalGatewayProcess(child, "SIGTERM", kill, {
          platform: "win32",
          runTaskkill,
        }),
      ).toBe(true);
      expect(runTaskkill).toHaveBeenNthCalledWith(
        1,
        expectedTaskkillPath(),
        ["/PID", "12345", "/T"],
        {
          stdio: "ignore",
        },
      );

      expect(
        signalGatewayProcess(child, "SIGKILL", kill, {
          platform: "win32",
          runTaskkill,
        }),
      ).toBe(true);
      expect(runTaskkill).toHaveBeenNthCalledWith(
        2,
        expectedTaskkillPath(),
        ["/PID", "12345", "/T", "/F"],
        {
          stdio: "ignore",
        },
      );
      expect(kill).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
    });
  });

  it("force-kills Windows gateway process trees when graceful taskkill fails", () => {
    withDefaultWindowsSystemRoot(() => {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        kill: vi.fn(),
        pid: 12345,
        signalCode: null,
      });
      const kill = vi.fn(() => true);
      const runTaskkill = vi
        .fn()
        .mockReturnValueOnce({ error: undefined, status: 1 })
        .mockReturnValueOnce({ error: undefined, status: 0 });

      expect(
        signalGatewayProcess(child, "SIGTERM", kill, {
          platform: "win32",
          runTaskkill,
        }),
      ).toBe(true);

      expect(runTaskkill).toHaveBeenNthCalledWith(
        1,
        expectedTaskkillPath(),
        ["/PID", "12345", "/T"],
        {
          stdio: "ignore",
        },
      );
      expect(runTaskkill).toHaveBeenNthCalledWith(
        2,
        expectedTaskkillPath(),
        ["/PID", "12345", "/T", "/F"],
        {
          stdio: "ignore",
        },
      );
      expect(kill).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
    });
  });

  it("treats missing gateway process groups as already exited", () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(() => false),
      pid: 12345,
      signalCode: null,
    });
    const kill = vi.fn(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    const runTaskkill = vi.fn(() => ({ error: new Error("not found"), status: 1 }));

    expect(signalGatewayProcess(child, "SIGTERM", kill, { runTaskkill })).toBe(false);
  });

  it("checks process group liveness instead of only the pnpm wrapper", () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: 0,
      kill: vi.fn(),
      pid: 12345,
      signalCode: null,
    });
    const kill = vi.fn(() => true);

    if (process.platform === "win32") {
      expect(isGatewayProcessAlive(child, kill)).toBe(false);
    } else {
      expect(isGatewayProcessAlive(child, kill)).toBe(true);
      expect(kill).toHaveBeenCalledWith(-12345, 0);
    }
  });

  it("force-kills the gateway process group after the graceful stop window", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      pid: 12346,
      signalCode: null,
    });
    const kill = vi.fn(() => true);
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    await stopGateway(child, { killGraceMs: 1, killProcess: kill, runTaskkill });

    if (process.platform === "win32") {
      expect(runTaskkill).toHaveBeenNthCalledWith(
        1,
        expectedTaskkillPath(),
        ["/PID", "12346", "/T"],
        {
          stdio: "ignore",
        },
      );
      expect(runTaskkill).toHaveBeenNthCalledWith(
        2,
        expectedTaskkillPath(),
        ["/PID", "12346", "/T", "/F"],
        {
          stdio: "ignore",
        },
      );
      expect(child.kill).not.toHaveBeenCalled();
    } else {
      expect(kill).toHaveBeenNthCalledWith(1, -12346, 0);
      expect(kill).toHaveBeenNthCalledWith(2, -12346, "SIGTERM");
      expect(kill).toHaveBeenCalledWith(-12346, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it("waits for the process group to disappear after force kill", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      pid: 12350,
      signalCode: null,
    });
    let sawForceKill = false;
    let postKillLivenessChecks = 0;
    const kill = vi.fn((_pid: number, signal: number | NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        sawForceKill = true;
        return true;
      }
      if (signal === 0 && sawForceKill) {
        postKillLivenessChecks += 1;
        if (postKillLivenessChecks >= 2) {
          throw Object.assign(new Error("no such process"), { code: "ESRCH" });
        }
      }
      return true;
    });
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    await stopGateway(child, {
      forceKillGraceMs: 50,
      killGraceMs: 1,
      killProcess: kill,
      runTaskkill,
    });

    if (process.platform === "win32") {
      expect(runTaskkill).toHaveBeenNthCalledWith(
        1,
        expectedTaskkillPath(),
        ["/PID", "12350", "/T"],
        {
          stdio: "ignore",
        },
      );
      expect(runTaskkill).toHaveBeenNthCalledWith(
        2,
        expectedTaskkillPath(),
        ["/PID", "12350", "/T", "/F"],
        {
          stdio: "ignore",
        },
      );
      expect(child.kill).not.toHaveBeenCalled();
    } else {
      expect(kill).toHaveBeenCalledWith(-12350, "SIGKILL");
      expect(postKillLivenessChecks).toBe(2);
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it("does not trust a finished pnpm wrapper while the process group is alive", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: 0,
      kill: vi.fn(),
      pid: 12347,
      signalCode: null,
    });
    const kill = vi.fn(() => true);
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    await stopGateway(child, { killGraceMs: 1, killProcess: kill, runTaskkill });

    if (process.platform === "win32") {
      expect(child.kill).not.toHaveBeenCalled();
    } else {
      expect(kill).toHaveBeenNthCalledWith(1, -12347, 0);
      expect(kill).toHaveBeenNthCalledWith(2, -12347, "SIGTERM");
      expect(kill).toHaveBeenCalledWith(-12347, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it("gives gateway process groups a grace window before re-raising parent signals", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      pid: 12348,
      signalCode: null,
    });
    const processLike = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 98765,
    });
    const kill = vi.fn(() => true);
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    try {
      const removeCleanup = installGatewayParentCleanup(child, {
        killProcess: kill,
        processLike,
        runTaskkill,
      });
      processLike.emit("SIGTERM");

      if (process.platform === "win32") {
        expect(runTaskkill).toHaveBeenCalledWith(expectedTaskkillPath(), ["/PID", "12348", "/T"], {
          stdio: "ignore",
        });
        expect(child.kill).not.toHaveBeenCalled();
        expect(processLike.kill).toHaveBeenCalledWith(98765, "SIGTERM");
      } else {
        expect(kill).toHaveBeenNthCalledWith(1, -12348, "SIGTERM");
        expect(kill).toHaveBeenNthCalledWith(2, -12348, 0);
        expect(kill).not.toHaveBeenCalledWith(-12348, "SIGKILL");
        expect(processLike.kill).not.toHaveBeenCalled();
        removeCleanup();

        await vi.advanceTimersByTimeAsync(250);

        expect(kill).toHaveBeenCalledWith(-12348, "SIGKILL");
        expect(child.kill).not.toHaveBeenCalled();
        expect(processLike.kill).toHaveBeenCalledWith(98765, "SIGTERM");
      }
      expect(processLike.listenerCount("SIGTERM")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up the gateway process group on parent exit", () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      pid: 12349,
      signalCode: null,
    });
    const processLike = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      pid: 98766,
    });
    const kill = vi.fn(() => true);
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    const removeCleanup = installGatewayParentCleanup(child, {
      killProcess: kill,
      processLike,
      runTaskkill,
    });
    processLike.emit("exit");

    if (process.platform === "win32") {
      expect(runTaskkill).toHaveBeenCalledWith(expectedTaskkillPath(), ["/PID", "12349", "/T"], {
        stdio: "ignore",
      });
      expect(child.kill).not.toHaveBeenCalled();
    } else {
      expect(kill).toHaveBeenNthCalledWith(1, -12349, "SIGTERM");
      expect(kill).toHaveBeenNthCalledWith(2, -12349, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
    }
    expect(processLike.kill).not.toHaveBeenCalled();

    removeCleanup();
  });

  it("fails readiness immediately when the gateway already exited", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: 1,
      signalCode: null,
    });
    const fetchImpl = vi.fn();

    await expect(
      waitForGatewayReady({
        child,
        fetchImpl,
        port: 12345,
        readyTimeoutMs: 10_000,
        sleepMs: 1,
        stderrPath: "/no/such/stderr.log",
      }),
    ).rejects.toThrow("gateway exited before readiness code=1 signal=null");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces temp root cleanup failures", async () => {
    const rmImpl = vi.fn().mockRejectedValue(new Error("device busy"));

    await expect(cleanupTempRoot("/tmp/rpc-rtt-stuck", { rmImpl })).rejects.toThrow(
      "failed to remove RPC RTT temp root: device busy",
    );
    expect(rmImpl).toHaveBeenCalledWith("/tmp/rpc-rtt-stuck", {
      force: true,
      recursive: true,
    });
  });

  it("bounds readiness probes and keeps polling after a stalled response", async () => {
    const child = new EventEmitter();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start() {} })))
      .mockResolvedValueOnce(jsonResponse({ ok: true, status: "live" }))
      .mockResolvedValueOnce(jsonResponse({ failing: [], ready: true }));

    await waitForGatewayReady({
      child,
      fetchImpl,
      port: 12345,
      probeTimeoutMs: 7,
      readyTimeoutMs: 50,
      sleepMs: 1,
      stderrPath: "/no/such/stderr.log",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:12345/readyz",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:12345/healthz",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:12345/readyz",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("waits for /readyz even when /healthz is live", async () => {
    const child = new EventEmitter();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ failing: ["gateway"], ready: false }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, status: "live" }))
      .mockResolvedValueOnce(jsonResponse({ failing: [], ready: true }));

    await waitForGatewayReady({
      child,
      fetchImpl,
      port: 12345,
      probeTimeoutMs: 7,
      readyTimeoutMs: 50,
      sleepMs: 1,
      stderrPath: "/no/such/stderr.log",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:12345/readyz",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:12345/healthz",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:12345/readyz",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("cancels unconsumed readiness probe response bodies", async () => {
    const child = new EventEmitter();
    let readyzCanceled = false;
    let healthzCanceled = false;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        body: {
          async cancel() {
            readyzCanceled = true;
          },
        },
        ok: false,
        status: 503,
      })
      .mockResolvedValueOnce({
        body: {
          async cancel() {
            healthzCanceled = true;
          },
        },
        ok: true,
        status: 200,
      })
      .mockResolvedValueOnce(jsonResponse({ failing: [], ready: true }));

    await waitForGatewayReady({
      child,
      fetchImpl,
      port: 12345,
      probeTimeoutMs: 7,
      readyTimeoutMs: 50,
      sleepMs: 1,
      stderrPath: "/no/such/stderr.log",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(readyzCanceled).toBe(true);
    expect(healthzCanceled).toBe(true);
  });
});
