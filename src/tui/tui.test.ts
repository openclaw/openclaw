// Covers core TUI state transitions and backend event rendering.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { acquireGatewayLock, type GatewayLockOptions } from "../infra/gateway-lock.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../shared/assistant-error-format.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnv } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { resolveFinalAssistantText } from "./tui-formatters.js";
import { beginTuiShutdown } from "./tui-shutdown.js";
import {
  formatTuiAuthCommandArgv,
  resolveLocalAuthSpawnInvocation,
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
  isTuiBusyActivityStatus,
  resolveTuiCtrlCAction,
  resolveTuiLocalAuthCliInvocation,
  resolveTuiSessionKey,
  resolveTuiSessionSelection,
  stopTuiSafely,
} from "./tui.js";

it("resolveFinalAssistantText formats malformed fragments when final and streamed text are empty", () => {
  expect(
    resolveFinalAssistantText({
      finalText: "",
      streamedText: "",
      errorMessage: MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
    }),
  ).toBe("LLM streaming response contained a malformed fragment. Please try again.");
});

it("resolveTuiLocalAuthCliInvocation filters inspector flags while preserving CLI runtime context", () => {
  const originalArgv = [...process.argv];
  try {
    const cliEntry = path.resolve("openclaw.mjs");
    process.argv[1] = cliEntry;

    expect(
      resolveTuiLocalAuthCliInvocation({
        provider: "test-provider",
        execArgv: [
          "--import",
          "/repo/node_modules/tsx/dist/loader.mjs",
          "--inspect-brk=0",
          "--trace-warnings",
        ],
      }),
    ).toStrictEqual({
      command: process.execPath,
      args: [
        "--import",
        "/repo/node_modules/tsx/dist/loader.mjs",
        "--trace-warnings",
        cliEntry,
        "models",
        "auth",
        "login",
        "--provider",
        "test-provider",
      ],
      cwd: path.resolve("."),
    });
  } finally {
    process.argv = originalArgv;
  }
});

it("isTuiBusyActivityStatus treats post-connect initialization as visibly busy", () => {
  expect(isTuiBusyActivityStatus("starting up")).toBe(true);
});

describe("resolveTuiToolsToggleActivityStatus", () => {
  it.each([
    { currentStatus: "streaming", toolsExpanded: true, expected: "streaming" },
    { currentStatus: "idle", toolsExpanded: false, expected: "tools collapsed" },
  ])("resolves the tool toggle while $currentStatus", ({ expected, ...input }) => {
    expect(resolveTuiToolsToggleActivityStatus(input)).toBe(expected);
  });
});

it("resolveTuiSessionKey uses global only as the default when scope is global", () => {
  expect(
    resolveTuiSessionKey({
      raw: "",
      sessionScope: "global",
      currentAgentId: "main",
      sessionMainKey: "agent:main:main",
    }),
  ).toBe("global");
  expect(
    resolveTuiSessionKey({
      raw: "test123",
      sessionScope: "global",
      currentAgentId: "main",
      sessionMainKey: "agent:main:main",
    }),
  ).toBe("agent:main:test123");
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
    { initialSessionInput: "", cwd: "/tmp/openclaw/projects/ops/src", expected: "ops" },
    {
      initialSessionInput: "agent:main:incident",
      agentId: "ops",
      cwd: "/tmp/openclaw/projects/ops/src",
      expected: "main",
    },
    {
      initialSessionInput: "global",
      agentId: "ops",
      cwd: "/tmp/openclaw",
      expected: "ops",
    },
  ])("resolves initial owner for '$initialSessionInput' in $cwd", ({ expected, ...input }) => {
    expect(resolveInitialTuiAgentId({ cfg, fallbackAgentId: "main", ...input })).toBe(expected);
  });

  it("falls back when the working directory was deleted", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("ENOENT: uv_cwd");
    });

    try {
      expect(resolveInitialTuiAgentId({ cfg, fallbackAgentId: "main" })).toBe("main");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("keeps an ownerless explicit fleet selection-required", () => {
    const retained = retainLegacyDefaultAgentId(structuredClone(cfg), "ops");
    expect(() => resolveInitialTuiAgentId({ cfg: retained, cwd: "/var/tmp/unrelated" })).toThrow(
      "Multiple agents are configured, but TUI startup has no explicit owner. Pass an agent-scoped --session key (e.g., 'openclaw tui --session agent:agentname:main').",
    );
  });

  it("uses the persisted fixed-store owner for an unscoped global session", () => {
    const restartConfig: OpenClawConfig = {
      session: { scope: "global", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { main: {}, ops: {} },
      },
    };

    expect(
      resolveInitialTuiAgentId({
        cfg: restartConfig,
        initialSessionInput: "global",
        cwd: "/tmp/openclaw",
      }),
    ).toBe("ops");
    expect(resolveInitialTuiAgentId({ cfg: restartConfig, cwd: "/tmp/openclaw" })).toBe("ops");
  });
});

describe("resolveTuiSessionSelection", () => {
  it.each([
    {
      raw: "incident-42",
      cfg: {
        session: { store: "/tmp/shared.sqlite" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
      },
    },
    {
      raw: "agent:ops:global",
      cfg: { agents: { ownership: "explicit", entries: { ops: {}, research: {} } } },
    },
  ] satisfies { raw: string; cfg: OpenClawConfig }[])(
    "keeps the owner and key for $raw",
    ({ raw, cfg }) => {
      expect(
        resolveTuiSessionSelection({
          raw,
          cfg,
          sessionScope: "per-sender",
          currentAgentId: "research",
          sessionMainKey: "main",
        }),
      ).toEqual({ key: raw, agentId: "ops" });
    },
  );
});

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

describe("createBackspaceDeduper", () => {
  function withLegacyBackspaceEnv<T>(fn: () => T): T {
    return withEnv(
      {
        WT_SESSION: undefined,
        SSH_CONNECTION: undefined,
        SSH_CLIENT: undefined,
        SSH_TTY: undefined,
      },
      fn,
    );
  }

  function createTimedDedupe(start = 1000) {
    let now = start;
    const dedupe = createBackspaceDeduper({
      dedupeWindowMs: 8,
      now: () => now,
    });
    return {
      dedupe,
      advance: (deltaMs: number) => {
        now += deltaMs;
      },
    };
  }

  it.each([
    {
      name: "ASCII BS as the first event",
      input: ["\x08", "\x7f"],
      expected: ["\x08", ""],
      interval: 1,
    },
    {
      name: "complementary events outside the dedupe window",
      input: ["\x7f", "\x08"],
      expected: ["\x7f", "\x08"],
      interval: 10,
    },
    {
      name: "consecutive DEL events",
      input: ["\x7f", "\x7f"],
      expected: ["\x7f", "\x7f"],
    },
    {
      name: "an intervening printable key",
      input: ["\x7f", "a", "\x08"],
      expected: ["\x7f", "a", "\x08"],
    },
    {
      name: "independently repeated complementary legacy pairs",
      input: ["\x7f", "\x08", "\x7f", "\x08"],
      expected: ["\x7f", "", "\x7f", ""],
    },
  ])("handles $name", ({ input, expected, interval = 0 }) => {
    withLegacyBackspaceEnv(() => {
      const { dedupe, advance } = createTimedDedupe();
      expect(
        input.map((data) => {
          const result = dedupe(data);
          advance(interval);
          return result;
        }),
      ).toEqual(expected);
    });
  });

  it("preserves Ctrl+Backspace in Windows Terminal", () => {
    withEnv(
      {
        WT_SESSION: "openclaw-tui-test",
        SSH_CONNECTION: undefined,
        SSH_CLIENT: undefined,
        SSH_TTY: undefined,
      },
      () => {
        const { dedupe } = createTimedDedupe();

        expect(["\x7f", "\x08", "\x7f"].map(dedupe)).toEqual(["\x7f", "\x08", "\x7f"]);
      },
    );
  });
});

describe("resolveCtrlCAction", () => {
  it.each([
    { now: 2800, action: "exit", nextLastCtrlCAt: 2000 },
    { now: 3501, action: "warn", nextLastCtrlCAt: 3501 },
  ])("returns $action at $now", ({ now, action, nextLastCtrlCAt }) => {
    expect(resolveCtrlCAction({ hasInput: false, now, lastCtrlCAt: 2000 })).toEqual({
      action,
      nextLastCtrlCAt,
    });
  });
});

describe("resolveTuiCtrlCAction", () => {
  it.each([
    { hasInput: false, lastCtrlCAt: 0, wasDisconnected: true, action: "exit", nextLastCtrlCAt: 0 },
    {
      hasInput: true,
      lastCtrlCAt: 0,
      wasDisconnected: true,
      action: "clear",
      nextLastCtrlCAt: 2000,
    },
    {
      hasInput: true,
      lastCtrlCAt: 1000,
      exitRequested: true,
      action: "closing",
      nextLastCtrlCAt: 1000,
    },
  ])("returns $action for interrupted TUI state", ({ action, nextLastCtrlCAt, ...input }) => {
    expect(resolveTuiCtrlCAction({ now: 2000, ...input })).toEqual({ action, nextLastCtrlCAt });
  });
});

it("createTuiConnectionLineage keeps a startup retry before the first hello out of reconnect recovery", () => {
  const lineage = createTuiConnectionLineage();

  lineage.disconnect();
  expect(lineage.wasDisconnected()).toBe(false);
  expect(lineage.connect()).toBe(false);

  lineage.disconnect();
  expect(lineage.wasDisconnected()).toBe(true);
  expect(lineage.connect()).toBe(true);
});

describe("TUI shutdown safety", () => {
  const beginTestShutdown = (overrides: Partial<Parameters<typeof beginTuiShutdown>[0]> = {}) =>
    beginTuiShutdown({
      stopClient: vi.fn(),
      stopTui: vi.fn(),
      disposeStatus: vi.fn(),
      requestFinish: vi.fn(),
      onError: vi.fn(),
      ...overrides,
    });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("disposes every status animation before teardown and after it settles", async () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const statusTimer = setInterval(tick, 1000);
    const waitingTimer = setInterval(tick, 120);
    const loaderTimer = setInterval(tick, 80);
    const statusTimeout = setTimeout(tick, 5000);
    const loader = { stop: vi.fn(() => clearInterval(loaderTimer)) };
    const disposeStatus = vi.fn(() => {
      clearInterval(statusTimer);
      clearInterval(waitingTimer);
      clearTimeout(statusTimeout);
      loader.stop();
    });

    const shutdown = beginTestShutdown({ disposeStatus });

    expect(disposeStatus).toHaveBeenCalledOnce();
    expect(loader.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    await shutdown;

    expect(disposeStatus).toHaveBeenCalledTimes(2);
    expect(loader.stop).toHaveBeenCalledTimes(2);
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

    expect(drainInput).toHaveBeenCalledOnce();
    expect(drainInput).toHaveBeenCalledWith(500, 100);
    expect(stop).toHaveBeenCalledOnce();
    expect(calls).toEqual(["drain", "stop"]);
  });

  it.each([
    {
      errors: [new Error("setRawMode EBADF"), { code: "EBADF", syscall: "setRawMode" }],
      ignorable: true,
    },
    {
      errors: [new Error("something else failed"), { code: "EIO", syscall: "write" }],
      ignorable: false,
    },
  ])(
    "classifies message and structured stop errors (ignorable=$ignorable)",
    ({ errors, ignorable }) => {
      for (const error of errors) {
        expect(isIgnorableTuiStopError(error)).toBe(ignorable);
      }
    },
  );

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
    const stdin = new EventEmitter() as EventEmitter & {
      on(event: "close" | "end", listener: () => void): unknown;
      off(event: "close" | "end", listener: () => void): unknown;
    };
    const stdout = new EventEmitter() as EventEmitter & {
      on(event: "close" | "end", listener: () => void): unknown;
      off(event: "close" | "end", listener: () => void): unknown;
    };
    const requestExit = vi.fn();

    const cleanup = installTuiTerminalLossExitHandler(requestExit, { stdin, stdout });
    stdin.emit("end");
    stdout.emit("close");
    cleanup();
    stdin.emit("close");

    expect(requestExit).toHaveBeenCalledTimes(1);
  });

  it("resolves terminal-loss exits requested before the TUI finish handler is installed", () => {
    const deferredFinish = createDeferredTuiFinish();
    const finish = vi.fn();

    deferredFinish.requestFinish();
    expect(finish).not.toHaveBeenCalled();

    deferredFinish.setFinish(finish);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("completes shutdown after resources and terminal settle", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const recordPhase = (phase: string) => async () => {
      calls.push(phase);
    };
    await beginTestShutdown({
      stopCommandScopes: recordPhase("scopes"),
      stopClient: recordPhase("client"),
      stopTui: recordPhase("tui"),
      disposeStatus: () => {
        calls.push("status");
      },
      requestFinish: () => {
        calls.push("finish");
      },
    });

    expect(calls).toEqual(["status", "scopes", "client", "tui", "status", "finish"]);
  });

  it("attempts terminal shutdown after transport teardown rejects", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const transportError = new Error("transport stop failed");
    let finishTuiStop: (() => void) | undefined;
    const stopTui = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          calls.push("tui");
          finishTuiStop = resolve;
        }),
    );
    const requestFinish = vi.fn(() => calls.push("finish"));
    const onError = vi.fn((error: unknown) => {
      calls.push("error");
      expect(error).toBe(transportError);
    });

    const shutdown = beginTestShutdown({
      stopClient: async () => {
        calls.push("client");
        throw transportError;
      },
      stopTui,
      requestFinish,
      onError,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["client", "tui"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(requestFinish).not.toHaveBeenCalled();

    finishTuiStop?.();
    await shutdown;
    expect(calls).toEqual(["client", "tui", "error", "finish"]);
    expect(stopTui).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(onError).toHaveBeenCalledOnce();
    expect(requestFinish).toHaveBeenCalledOnce();
  });

  it("reports transport and terminal shutdown errors in phase order", async () => {
    vi.useFakeTimers();
    const scopeError = new Error("command scope stop failed");
    const transportError = new Error("transport stop failed");
    const terminalError = new Error("terminal stop failed");
    const onError = vi.fn();
    const requestFinish = vi.fn();

    await beginTestShutdown({
      stopCommandScopes: async () => {
        throw scopeError;
      },
      stopClient: async () => {
        throw transportError;
      },
      stopTui: async () => {
        throw terminalError;
      },
      onError,
      requestFinish,
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
    const stopTui = vi.fn();
    const requestFinish = vi.fn();
    const shutdown = beginTestShutdown({
      stopCommandScopes: () => scopes.promise,
      stopClient: () => client.promise,
      stopTui,
      requestFinish,
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

it("resolveLocalAuthSpawnInvocation keeps direct execution for non-wrapper commands", () => {
  expect(
    resolveLocalAuthSpawnInvocation({
      command: "/usr/local/bin/codex",
      args: ["login"],
      platform: "linux",
    }),
  ).toStrictEqual({ command: "/usr/local/bin/codex", args: ["login"], options: {} });
  expect(
    resolveLocalAuthSpawnInvocation({
      command: "C:\\tools\\codex.exe",
      args: ["login"],
      platform: "win32",
    }),
  ).toStrictEqual({ command: "C:\\tools\\codex.exe", args: ["login"], options: {} });
});

function createGatewayLockOptions(stateDir: string): GatewayLockOptions {
  return {
    allowInTests: true,
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: stateDir,
    },
    lockDir: path.join(stateDir, "gateway-locks"),
    readProcessStartTime: () => 123_456,
    // Live-owner inspection and uncontended acquisition never wait on this; it only
    // bounds lock-file inspection, which loaded small hosts can push past 100ms.
    timeoutMs: 5_000,
  };
}

function createSignalProcess() {
  type SignalName = "SIGINT" | "SIGTERM";
  const listeners = new Map<SignalName, Set<() => void>>();
  const processLike = {
    on(signal: SignalName, handler: () => void) {
      const current = listeners.get(signal) ?? new Set<() => void>();
      current.add(handler);
      listeners.set(signal, current);
      return processLike;
    },
    off(signal: SignalName, handler: () => void) {
      listeners.get(signal)?.delete(handler);
      return processLike;
    },
  };
  return {
    processLike,
    listenerCount(signal: SignalName) {
      return listeners.get(signal)?.size ?? 0;
    },
    emit(signal: SignalName) {
      for (const handler of listeners.get(signal) ?? []) {
        handler();
      }
    },
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
      const embeddedStateLock = await import("../infra/embedded-state-lock.js");
      const release = vi.fn(async () => {
        if (releaseFails) {
          throw new Error("state lock release failed");
        }
      });
      const acquire = vi.spyOn(embeddedStateLock, "acquireEmbeddedStateLock").mockResolvedValue({
        release,
      });
      const signals = createSignalProcess();
      try {
        const run = withEmbeddedTuiStateLock(
          async () => {
            expect(signals.listenerCount("SIGINT")).toBe(1);
            expect(signals.listenerCount("SIGTERM")).toBe(1);
            if (outcome === "error") {
              throw new Error("local TUI failed");
            }
            if (outcome === "early return") {
              return undefined;
            }
            return "complete";
          },
          { process: signals.processLike },
        );
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
      } finally {
        acquire.mockRestore();
      }
    },
  );

  it("refuses local startup while a live Gateway owns the state directory", async () => {
    await withTempDir("openclaw-tui-state-lock-", async (stateDir) => {
      const lockOptions = createGatewayLockOptions(stateDir);
      const gatewayLock = await acquireGatewayLock({ ...lockOptions, port: 28789 });
      expect(gatewayLock).not.toBeNull();
      if (!gatewayLock) {
        throw new Error("Expected live Gateway fixture lock");
      }
      const run = vi.fn(async () => undefined);
      try {
        await expect(
          withEmbeddedTuiStateLock(run, { gatewayLockOptions: lockOptions }),
        ).rejects.toThrow(
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
      const stateLockPath = path.join(lockOptions.lockDir!, "gateway.state.lock");
      const signals = createSignalProcess();
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const run = withEmbeddedTuiStateLock(
        async (signal) => {
          const payload: unknown = JSON.parse(await fs.readFile(stateLockPath, "utf8"));
          expect(payload).toMatchObject({ pid: process.pid, role: "agent-embedded" });
          markStarted();
          return await new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("local TUI interrupted")), {
              once: true,
            });
          });
        },
        { gatewayLockOptions: lockOptions, process: signals.processLike },
      );
      await started;
      signals.emit("SIGTERM");

      await expect(run).rejects.toThrow("local TUI interrupted");
      await expect(fs.stat(stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
