import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import * as embeddedStateLock from "../infra/embedded-state-lock.js";
import { captureNativeSignalBridge } from "../infra/embedded-state-lock.test-support.js";
import * as gatewayLockProcessModule from "../infra/gateway-lock-process.js";
import { acquireGatewayLock, type GatewayLockOptions } from "../infra/gateway-lock.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../shared/assistant-error-format.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnv } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { isTuiBusyActivityStatus } from "./tui-activity-status.js";
import { resolveLocalAuthSpawnInvocation } from "./tui-auth-invocation.js";
import { resolveFinalAssistantText } from "./tui-formatters.js";
import { beginTuiShutdown } from "./tui-shutdown.js";
import {
  formatTuiAuthCommandArgv,
  withEmbeddedTuiStateLock,
  createBackspaceDeduper,
  createDeferredTuiFinish,
  createTuiConnectionLineage,
  drainAndStopTuiSafely,
  installTuiTerminalLossExitHandler,
  isIgnorableTuiStopError,
  isTuiTerminalLossError,
  resolveCtrlCAction,
  resolveGatewayDisconnectState,
  resolveInitialTuiAgentId,
  resolveTuiToolsToggleActivityStatus,
  resolveTuiCtrlCAction,
  resolveTuiLocalAuthCliInvocation,
  resolveTuiSessionSelection,
  stopTuiSafely,
} from "./tui.js";

const createNativeBridge = embeddedStateLock.createEmbeddedStateSignalBridge;
const acquireNativeStateLock = embeddedStateLock.acquireEmbeddedStateLock;
const signalCaptures: ReturnType<typeof captureNativeSignalBridge>[] = [];

function captureTuiSignals() {
  const signals = captureNativeSignalBridge(createNativeBridge);
  signalCaptures.push(signals);
  vi.spyOn(embeddedStateLock, "createEmbeddedStateSignalBridge").mockImplementationOnce(
    signals.create,
  );
  return signals;
}

function useTuiStateLockOptions(options: GatewayLockOptions) {
  vi.spyOn(embeddedStateLock, "acquireEmbeddedStateLock").mockImplementation((params) =>
    acquireNativeStateLock({ ...params, options }),
  );
}

afterEach(() => {
  try {
    for (const signals of signalCaptures) {
      signals.dispose();
    }
    signalCaptures.length = 0;
    vi.useRealTimers();
  } finally {
    vi.restoreAllMocks();
  }
});

it("resolveFinalAssistantText formats malformed fragments when final text is empty", () => {
  expect(
    resolveFinalAssistantText({
      finalText: "",
      errorMessage: MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
    }),
  ).toBe("LLM streaming response contained a malformed fragment. Please try again.");
});

it("resolveTuiLocalAuthCliInvocation filters inspector flags while preserving CLI runtime context", () => {
  const originalArgv = [...process.argv];
  const originalExecArgv = process.execArgv;
  try {
    const cliEntry = path.resolve("openclaw.mjs");
    const loaderArgs = ["--import", "/repo/node_modules/tsx/dist/loader.mjs"];
    const authArgs = ["models", "auth", "login", "--provider", "test-provider"];
    process.argv[1] = cliEntry;
    process.execArgv = [...loaderArgs, "--inspect-brk=0", "--trace-warnings"];

    expect(
      resolveTuiLocalAuthCliInvocation({
        provider: "test-provider",
      }),
    ).toStrictEqual({
      command: process.execPath,
      args: [...loaderArgs, "--trace-warnings", cliEntry, ...authArgs],
      cwd: path.resolve("."),
    });
  } finally {
    process.argv = originalArgv;
    process.execArgv = originalExecArgv;
  }
});

it("isTuiBusyActivityStatus treats post-connect initialization as visibly busy", () => {
  expect(isTuiBusyActivityStatus("starting up")).toBe(true);
});

it.each([
  ["streaming", true, "streaming"],
  ["idle", false, "tools collapsed"],
] as const)("resolves the tool toggle while %s", (currentStatus, toolsExpanded, expected) => {
  expect(resolveTuiToolsToggleActivityStatus({ currentStatus, toolsExpanded })).toBe(expected);
});

describe("resolveInitialTuiAgentId", () => {
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: {
        main: { workspace: "/tmp/openclaw" },
        ops: { workspace: "/tmp/openclaw/projects/ops" },
      },
    },
  };

  it.each([
    ["", undefined, "/tmp/openclaw/projects/ops/src", "ops"],
    ["agent:main:incident", "ops", "/tmp/openclaw/projects/ops/src", "main"],
    ["global", "ops", "/tmp/openclaw", "ops"],
  ])("resolves initial owner for %s", (initialSessionInput, agentId, cwd, expected) => {
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    expect(
      resolveInitialTuiAgentId({ cfg, fallbackAgentId: "main", initialSessionInput, agentId }),
    ).toBe(expected);
  });

  it("falls back when the working directory was deleted", () => {
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("ENOENT: uv_cwd");
    });
    expect(resolveInitialTuiAgentId({ cfg, fallbackAgentId: "main" })).toBe("main");
  });

  it("keeps an ownerless explicit fleet selection-required", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/var/tmp/unrelated");
    const retained = retainLegacyDefaultAgentId(structuredClone(cfg), "ops");
    expect(() => resolveInitialTuiAgentId({ cfg: retained })).toThrow(
      "Multiple agents are configured, but TUI startup has no explicit owner. Pass an agent-scoped --session key (e.g., 'openclaw tui --session agent:agentname:main').",
    );
  });

  it("uses the persisted fixed-store owner for an unscoped global session", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/tmp/openclaw");
    const restartConfig: OpenClawConfig = {
      session: { scope: "global", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { main: {}, ops: {} },
      },
    };

    for (const initialSessionInput of ["global", undefined]) {
      expect(resolveInitialTuiAgentId({ cfg: restartConfig, initialSessionInput })).toBe("ops");
    }
  });
});

it.each([
  ["", "global", "main", "global", "main"],
  ["test123", "global", "main", "agent:main:test123", "main"],
  ["incident-42", "per-sender", "research", "incident-42", "ops"],
  ["agent:ops:global", "per-sender", "research", "agent:ops:global", "ops"],
] as const)(
  "selects owner and canonical key for %j",
  (raw, sessionScope, currentAgentId, key, agentId) => {
    const agents: NonNullable<OpenClawConfig["agents"]> = {
      ownership: "explicit",
      entries: { ops: {}, research: {} },
    };
    const cfg: OpenClawConfig = currentAgentId === "research" ? { agents } : {};
    if (raw === "incident-42") {
      cfg.session = { store: "/tmp/shared.sqlite" };
      agents.defaults = { sessionStore: { agentId: "ops" } };
    }
    expect(
      resolveTuiSessionSelection({
        raw,
        cfg,
        sessionScope,
        currentAgentId,
        sessionMainKey: sessionScope === "global" ? "agent:main:main" : "main",
      }),
    ).toEqual({ key, agentId });
  },
);

describe("resolveGatewayDisconnectState", () => {
  it.each([
    {
      reason: "gateway starting",
      expected: { connectionStatus: "gateway starting", activityStatus: "starting up" },
    },
    {
      details: { code: "PAIRING_REQUIRED", reason: "scope-upgrade" },
      reason: "connect failed",
      expected: {
        activityStatus: "device approval needed: preview latest request",
        connectionStatus: expect.stringContaining("scope upgrade pending approval"),
        remediation: expect.stringContaining("openclaw devices approve --latest"),
      },
    },
    {
      details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
      reason: "device token mismatch",
      expected: {
        activityStatus: "gateway authentication needs attention",
        remediation: expect.stringContaining(
          "openclaw devices rotate --device <deviceId> --role operator",
        ),
      },
    },
    {
      details: { code: "AUTH_RATE_LIMITED" },
      reason: "unauthorized: too many failed authentication attempts (retry later)",
      expected: {
        activityStatus: "gateway authentication temporarily rate-limited",
        remediation: expect.stringContaining("temporary authentication lockout"),
      },
      forbidden: ["gateway.remote.token", "devices rotate"],
    },
    {
      details: { reason: "websocket-upgrade-rejected", httpStatus: 302 },
      reason: "gateway rejected websocket upgrade (HTTP 302)",
      expected: {
        activityStatus: "identity-aware proxy rejected connection",
        remediation: expect.stringContaining("gateway.remote.edgeAuth"),
      },
    },
    {
      reason: "network timeout",
      expected: {
        connectionStatus: "gateway disconnected: network timeout",
        activityStatus: "idle",
        remediation: undefined,
      },
    },
  ])("shows actionable disconnect state for $reason", ({ expected, forbidden, ...input }) => {
    const state = resolveGatewayDisconnectState(input);
    expect(state).toMatchObject(expected);
    if (input.reason === "gateway starting") {
      expect(state).toEqual(expected);
    }
    for (const text of forbidden ?? []) {
      expect(state.remediation).not.toContain(text);
    }
  });
});

function dedupeKeys(input: readonly string[], interval: number, windowsTerminal = false) {
  return withEnv(
    {
      WT_SESSION: windowsTerminal ? "openclaw-tui-test" : undefined,
      SSH_CONNECTION: undefined,
      SSH_CLIENT: undefined,
      SSH_TTY: undefined,
    },
    () => {
      let now = 1000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const dedupe = createBackspaceDeduper();
      return input.map((data) => {
        const result = dedupe(data);
        now += interval;
        return result;
      });
    },
  );
}
it.each([
  ["ASCII BS first", ["\x08", "\x7f"], ["\x08", ""], 1, false],
  ["outside the dedupe window", ["\x7f", "\x08"], ["\x7f", "\x08"], 10, false],
  ["consecutive DEL", ["\x7f", "\x7f"], ["\x7f", "\x7f"], 0, false],
  ["intervening printable key", ["\x7f", "a", "\x08"], ["\x7f", "a", "\x08"], 0, false],
  ["repeated pairs", ["\x7f", "\x08", "\x7f", "\x08"], ["\x7f", "", "\x7f", ""], 0, false],
  ["Windows Ctrl+Backspace", ["\x7f", "\x08", "\x7f"], ["\x7f", "\x08", "\x7f"], 0, true],
] as const)("deduplicates %s", (_name, input, expected, interval, windowsTerminal) => {
  expect(dedupeKeys(input, interval, windowsTerminal)).toEqual(expected);
});

it.each([
  [2800, "exit", 2000],
  [3501, "warn", 3501],
] as const)("resolves Ctrl-C at %s", (now, action, nextLastCtrlCAt) => {
  expect(resolveCtrlCAction({ hasInput: false, now, lastCtrlCAt: 2000 })).toEqual({
    action,
    nextLastCtrlCAt,
  });
});

it.each([
  [false, 0, true, undefined, "exit", 0],
  [true, 0, true, undefined, "clear", 2000],
  [true, 1000, undefined, true, "closing", 1000],
] as const)(
  "resolves interrupted Ctrl-C (input=%s, prior=%s)",
  (hasInput, lastCtrlCAt, wasDisconnected, exitRequested, action, nextLastCtrlCAt) => {
    expect(
      resolveTuiCtrlCAction({ now: 2000, hasInput, lastCtrlCAt, wasDisconnected, exitRequested }),
    ).toEqual({ action, nextLastCtrlCAt });
  },
);

it("createTuiConnectionLineage keeps a startup retry before the first hello out of reconnect recovery", () => {
  const lineage = createTuiConnectionLineage();
  for (const reconnect of [false, true]) {
    lineage.disconnect();
    expect([lineage.wasDisconnected(), lineage.connect()]).toEqual([reconnect, reconnect]);
  }
});

describe("TUI shutdown safety", () => {
  type Shutdown = Parameters<typeof beginTuiShutdown>[0];
  const reject = (error: Error) => async () => {
    throw error;
  };
  function shutdownFixture(overrides: Partial<Shutdown> = {}) {
    const calls: string[] = [];
    const record = (name: string) =>
      vi.fn(() => {
        calls.push(name);
      });
    const tasks = {
      stopClient: vi.fn(),
      stopTui: vi.fn<Shutdown["stopTui"]>(() => {
        calls.push("tui");
      }),
      disposeStatus: vi.fn(),
      requestFinish: record("finish"),
      onError: vi.fn<(error: unknown) => void>(),
    };
    return {
      ...tasks,
      calls,
      record,
      begin: (options: Partial<Shutdown> = {}) =>
        beginTuiShutdown({ ...tasks, ...overrides, ...options }),
    };
  }

  it("disposes every status animation before teardown and after it settles", async () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const timers = [1000, 120, 80].map((delay) => setInterval(tick, delay));
    const statusTimeout = setTimeout(tick, 5000);
    const disposeStatus = vi.fn(() => {
      timers.forEach(clearInterval);
      clearTimeout(statusTimeout);
    });

    const shutdown = shutdownFixture({ disposeStatus }).begin();

    expect(disposeStatus).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    await shutdown;

    expect(disposeStatus).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("rethrows non-ignorable stop errors after draining", async () => {
    const calls: string[] = [];
    const drainInput = vi.fn(async () => {
      calls.push("drain");
    });
    const stop = vi.fn(() => {
      calls.push("stop");
      throw new Error("boom");
    });

    await expect(
      drainAndStopTuiSafely({
        stop,
        terminal: { drainInput },
      }),
    ).rejects.toThrow("boom");

    expect(drainInput).toHaveBeenCalledWith(500, 100);
    expect(calls).toEqual(["drain", "stop"]);
  });

  it.each([
    [new Error("setRawMode EBADF"), true],
    [{ code: "EBADF", syscall: "setRawMode" }, true],
    [new Error("something else failed"), false],
    [{ code: "EIO", syscall: "write" }, false],
  ] as const)("classifies stop error %j", (error, ignorable) => {
    expect(isIgnorableTuiStopError(error)).toBe(ignorable);
  });

  it("swallows only ignorable stop errors", () => {
    expect(
      stopTuiSafely(() => {
        throw new Error("setRawMode EBADF");
      }),
    ).toBeUndefined();
  });

  it("classifies terminal-loss IO errors", () => {
    expect(isTuiTerminalLossError({ code: "EIO", syscall: "read" })).toBe(true);
    expect(isTuiTerminalLossError({ code: "EPIPE", syscall: "write" })).toBe(true);
    expect(isTuiTerminalLossError(new Error("read EIO at TTY.onStreamRead"))).toBe(true);
    expect(isTuiTerminalLossError(new Error("ordinary failure"))).toBe(false);
  });

  it("requests exit once when the TUI terminal closes", () => {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const requestExit = vi.fn();

    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout")!;
    Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
    Object.defineProperty(process, "stdout", { configurable: true, value: stdout });
    try {
      const cleanup = installTuiTerminalLossExitHandler(requestExit);
      stdin.emit("end");
      stdout.emit("close");
      cleanup();
      stdin.emit("close");

      expect(requestExit).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "stdin", stdinDescriptor);
      Object.defineProperty(process, "stdout", stdoutDescriptor);
    }
  });

  it("resolves terminal-loss exits requested before the TUI finish handler is installed", () => {
    const deferredFinish = createDeferredTuiFinish();
    const finish = vi.fn();

    deferredFinish.requestFinish();
    deferredFinish.setFinish(finish);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("completes shutdown after resources and terminal settle", async () => {
    const { calls, record, begin } = shutdownFixture();
    await begin({
      stopCommandScopes: record("scopes"),
      stopClient: record("client"),
      disposeStatus: record("status"),
    });

    expect(calls).toEqual(["status", "scopes", "client", "tui", "status", "finish"]);
  });

  it("attempts terminal shutdown after transport teardown rejects", async () => {
    vi.useFakeTimers();
    const { calls, stopTui, requestFinish, onError, begin } = shutdownFixture();
    const transportError = new Error("transport stop failed");
    const terminal = createDeferredCore();
    stopTui.mockImplementation(() => {
      calls.push("tui");
      return terminal.promise;
    });
    onError.mockImplementation((error) => {
      calls.push("error");
      expect(error).toBe(transportError);
    });

    const shutdown = begin({
      stopClient: async () => {
        calls.push("client");
        throw transportError;
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["client", "tui"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(requestFinish).not.toHaveBeenCalled();

    terminal.resolve();
    await shutdown;
    expect(calls).toEqual(["client", "tui", "error", "finish"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports transport and terminal shutdown errors in phase order", async () => {
    const scopeError = new Error("command scope stop failed");
    const transportError = new Error("transport stop failed");
    const terminalError = new Error("terminal stop failed");
    const { onError, requestFinish, begin } = shutdownFixture();
    await begin({
      stopCommandScopes: reject(scopeError),
      stopClient: reject(transportError),
      stopTui: reject(terminalError),
    });

    expect(onError).toHaveBeenCalledOnce();
    const error = onError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([scopeError, transportError, terminalError]);
    expect(requestFinish).toHaveBeenCalledOnce();
  });

  it("does not finish or release the terminal before owned cleanup settles", async () => {
    const scopes = createDeferredCore();
    const client = createDeferredCore();
    const { stopTui, requestFinish, begin } = shutdownFixture();
    const shutdown = begin({
      stopCommandScopes: () => scopes.promise,
      stopClient: () => client.promise,
    });
    scopes.resolve();
    await scopes.promise;
    expect(stopTui).not.toHaveBeenCalled();
    expect(requestFinish).not.toHaveBeenCalled();
    client.resolve();
    await shutdown;
    expect(stopTui).toHaveBeenCalledOnce();
    expect(requestFinish).toHaveBeenCalledOnce();
  });
});

describe("formatTuiAuthCommandArgv", () => {
  it("renders bounded redacted argv without shell semantics", () => {
    const rendered = formatTuiAuthCommandArgv("C:\\Users\\%USERNAME%\\codex.exe\n", ["login"]);
    expect(rendered).toContain("%USERNAME%");
    expect(rendered).toContain("\\n");
    expect(rendered).not.toContain("\n");

    const secret = "sk-proof-only-1234567890";
    expect(formatTuiAuthCommandArgv("codex", ["login", secret])).not.toContain(secret);
    expect(
      formatTuiAuthCommandArgv("/tmp/" + "x".repeat(400), ["login"]).length,
    ).toBeLessThanOrEqual(320);
  });

  it("keeps built-in masking when custom log patterns are configured", async () => {
    await withTempDir("openclaw-tui-auth-redaction-", async (dir) => {
      const configPath = path.join(dir, "openclaw.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({ logging: { redactPatterns: ["project-secret-\\d+"] } }),
      );
      const token = "sk-proof-only-1234567890";
      const customSecret = "project-secret-12345";

      const rendered = withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () =>
        formatTuiAuthCommandArgv("codex", ["login", token, customSecret]),
      );

      expect(rendered).not.toContain(token);
      expect(rendered).not.toContain(customSecret);
    });
  });
});

it.each([
  ["linux", "/usr/local/bin/codex"],
  ["win32", "C:\\tools\\codex.exe"],
] as const)("directly executes non-wrapper commands on %s", (platform, command) => {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  expect(resolveLocalAuthSpawnInvocation({ command, args: ["login"] })).toStrictEqual({
    command,
    args: ["login"],
    options: {},
  });
});

function createGatewayLockOptions(stateDir: string): GatewayLockOptions {
  vi.spyOn(gatewayLockProcessModule, "readGatewayLockProcessStartTime").mockImplementation(
    () => 123_456,
  );
  return {
    allowInTests: true,
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    },
    lockDir: path.join(stateDir, "gateway-locks"),
    // Live-owner inspection and uncontended acquisition never wait on this; it only
    // bounds lock-file inspection, which loaded small hosts can push past 100ms.
    timeoutMs: 5_000,
  };
}

describe("embedded TUI state ownership", () => {
  it.each([
    { outcome: "success", releaseFails: false },
    { outcome: "early return", releaseFails: false },
    { outcome: "error", releaseFails: false },
    { outcome: "success", releaseFails: true },
    { outcome: "early return", releaseFails: true },
    { outcome: "error", releaseFails: true },
  ])(
    "removes signal handlers after $outcome (releaseFails=$releaseFails)",
    async ({ outcome, releaseFails }) => {
      await withTempDir("openclaw-tui-state-release-", async (stateDir) => {
        const options = createGatewayLockOptions(stateDir);
        const release = vi.fn(async () => {
          if (releaseFails) {
            throw new Error("state lock release failed");
          }
        });
        vi.spyOn(embeddedStateLock, "acquireEmbeddedStateLock").mockImplementation(
          async (params) => {
            const lock = await acquireNativeStateLock({ ...params, options });
            assert(lock, "Expected native embedded state lock");
            const releaseNativeLock = lock.release;
            vi.spyOn(lock, "release").mockImplementation(async () => {
              await releaseNativeLock();
              await release();
            });
            return lock;
          },
        );
        const signals = captureTuiSignals();
        const run = withEmbeddedTuiStateLock(async () => {
          expect(signals.listenerCount("SIGINT")).toBe(1);
          expect(signals.listenerCount("SIGTERM")).toBe(1);
          if (outcome === "error") {
            throw new Error("local TUI failed");
          }
          return outcome === "success" ? "complete" : undefined;
        });
        if (releaseFails || outcome === "error") {
          await expect(run).rejects.toThrow(
            releaseFails ? "state lock release failed" : "local TUI failed",
          );
        } else {
          await expect(run).resolves.toBe(outcome === "success" ? "complete" : undefined);
        }
        expect(release).toHaveBeenCalledOnce();
        expect(signals.listenerCount("SIGINT")).toBe(0);
        expect(signals.listenerCount("SIGTERM")).toBe(0);
      });
    },
  );

  it("refuses local startup while a live Gateway owns the state directory", async () => {
    await withTempDir("openclaw-tui-state-lock-", async (stateDir) => {
      const lockOptions = createGatewayLockOptions(stateDir);
      useTuiStateLockOptions(lockOptions);
      const gatewayLock = await acquireGatewayLock({ ...lockOptions, port: 28789 });
      assert(gatewayLock, "Expected live Gateway fixture lock");
      const run = vi.fn(async () => undefined);
      try {
        await expect(withEmbeddedTuiStateLock(run)).rejects.toThrow(
          `A Gateway is running for this state directory (pid ${process.pid}, port 28789). Run without --local to use it, or stop the Gateway first (openclaw gateway stop).`,
        );
        expect(run).not.toHaveBeenCalled();
      } finally {
        await gatewayLock.release();
      }
    });
  });

  it("releases embedded state ownership when the local TUI receives SIGTERM", async () => {
    await withTempDir("openclaw-tui-state-lock-", async (stateDir) => {
      const lockOptions = createGatewayLockOptions(stateDir);
      useTuiStateLockOptions(lockOptions);
      const stateLockPath = path.join(lockOptions.lockDir!, "gateway.state.lock");
      const signals = captureTuiSignals();
      const started = createDeferredCore();
      const run = withEmbeddedTuiStateLock(async (signal) => {
        const payload: unknown = JSON.parse(await fs.readFile(stateLockPath, "utf8"));
        expect(payload).toMatchObject({ pid: process.pid, role: "agent-embedded" });
        started.resolve();
        return await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("local TUI interrupted")), {
            once: true,
          });
        });
      });
      await started.promise;
      signals.emit("SIGTERM");

      await expect(run).rejects.toThrow("local TUI interrupted");
      await expect(fs.stat(stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
