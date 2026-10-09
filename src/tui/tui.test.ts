// Covers core TUI state transitions and backend event rendering.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { acquireGatewayLock, type GatewayLockOptions } from "../infra/gateway-lock.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../shared/assistant-error-format.js";
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
  resolveTuiShutdownHardExitMs,
  resolveTuiSessionKey,
  resolveTuiSessionSelection,
  scheduleProcessExitAfterTuiReturn,
  stopTuiSafely,
} from "./tui.js";

describe("resolveFinalAssistantText", () => {
  it("formats malformed streaming fragment errors when final and streamed text are empty", () => {
    expect(
      resolveFinalAssistantText({
        finalText: "",
        streamedText: "",
        errorMessage: MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
      }),
    ).toBe("LLM streaming response contained a malformed fragment. Please try again.");
  });
});

describe("resolveTuiLocalAuthCliInvocation", () => {
  it("filters inspector flags while preserving the current CLI runtime context", () => {
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
});

describe("isTuiBusyActivityStatus", () => {
  it("treats post-connect initialization as a visible busy status", () => {
    expect(isTuiBusyActivityStatus("starting up")).toBe(true);
  });
});

describe("resolveTuiToolsToggleActivityStatus", () => {
  it("preserves busy status while an active run exists", () => {
    expect(
      resolveTuiToolsToggleActivityStatus({
        currentStatus: "streaming",
        toolsExpanded: true,
      }),
    ).toBe("streaming");
  });

  it("uses the tool toggle status when activity is idle", () => {
    expect(
      resolveTuiToolsToggleActivityStatus({
        currentStatus: "idle",
        toolsExpanded: false,
      }),
    ).toBe("tools collapsed");
  });
});

describe("resolveTuiShutdownHardExitMs", () => {
  it("keeps gateway shutdown bounded by the hard-exit timer", () => {
    expect(resolveTuiShutdownHardExitMs({ localMode: false })).toBe(2000);
  });

  it("ignores partial local run shutdown grace values", () => {
    withEnv({ OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: "3456abc" }, () => {
      expect(resolveTuiShutdownHardExitMs({ localMode: true })).toBe(122000);
    });
  });

  it("clamps oversized local run shutdown grace values", () => {
    withEnv({ OPENCLAW_TUI_LOCAL_RUN_SHUTDOWN_GRACE_MS: String(Number.MAX_SAFE_INTEGER) }, () => {
      expect(resolveTuiShutdownHardExitMs({ localMode: true })).toBe(MAX_TIMER_TIMEOUT_MS + 2000);
    });
  });
});

describe("resolveTuiSessionKey", () => {
  it("uses global only as the default when scope is global", () => {
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

  it("infers agent from cwd when session is not agent-prefixed", () => {
    expect(
      resolveInitialTuiAgentId({
        cfg,
        fallbackAgentId: "main",
        initialSessionInput: "",
        cwd: "/tmp/openclaw/projects/ops/src",
      }),
    ).toBe("ops");
  });

  it("keeps explicit agent prefix from --session", () => {
    expect(
      resolveInitialTuiAgentId({
        cfg,
        fallbackAgentId: "main",
        initialSessionInput: "agent:main:incident",
        agentId: "ops",
        cwd: "/tmp/openclaw/projects/ops/src",
      }),
    ).toBe("main");
  });

  it("keeps an explicit global-session agent ahead of workspace inference", () => {
    expect(
      resolveInitialTuiAgentId({
        cfg,
        fallbackAgentId: "main",
        initialSessionInput: "global",
        agentId: "ops",
        cwd: "/tmp/openclaw",
      }),
    ).toBe("ops");
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
  it.each([{ raw: "incident-42", expected: "incident-42" }])(
    "keeps the persisted owner when selecting fixed-store $raw",
    ({ raw, expected }) => {
      const cfg: OpenClawConfig = {
        session: { store: "/tmp/shared.sqlite" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
      };

      expect(
        resolveTuiSessionSelection({
          raw,
          cfg,
          sessionScope: "per-sender",
          currentAgentId: "research",
          sessionMainKey: "main",
        }),
      ).toEqual({ key: expected, agentId: "ops" });
    },
  );

  it("carries an explicit owner without reinterpreting the qualified global selector", () => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };
    expect(
      resolveTuiSessionSelection({
        raw: "agent:ops:global",
        cfg,
        sessionScope: "per-sender",
        currentAgentId: "research",
        sessionMainKey: "main",
      }),
    ).toEqual({ key: "agent:ops:global", agentId: "ops" });
  });
});

describe("resolveGatewayDisconnectState", () => {
  it("shows startup progress while the gateway keeps retrying", () => {
    expect(resolveGatewayDisconnectState({ reason: "gateway starting" })).toEqual({
      connectionStatus: "gateway starting",
      activityStatus: "starting up",
    });
  });

  it("uses structured pairing details before the generic close reason", () => {
    const state = resolveGatewayDisconnectState({
      details: { code: "PAIRING_REQUIRED", reason: "scope-upgrade" },
      reason: "connect failed",
    });
    expect(state.activityStatus).toBe("device approval needed: preview latest request");
    expect(state.connectionStatus).toContain("scope upgrade pending approval");
    expect(state.remediation).toContain("openclaw devices approve --latest");
  });

  it("shows the device-token rotation command for structured token mismatch", () => {
    const state = resolveGatewayDisconnectState({
      details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
      reason: "device token mismatch",
    });
    expect(state.activityStatus).toBe("gateway authentication needs attention");
    expect(state.remediation).toContain(
      "openclaw devices rotate --device <deviceId> --role operator",
    );
  });

  it("shows wait-and-retry guidance for a temporary authentication lockout", () => {
    const state = resolveGatewayDisconnectState({
      details: { code: "AUTH_RATE_LIMITED" },
      reason: "unauthorized: too many failed authentication attempts (retry later)",
    });
    expect(state.activityStatus).toBe("gateway authentication temporarily rate-limited");
    expect(state.remediation).toContain("temporary authentication lockout");
    expect(state.remediation).not.toContain("gateway.remote.token");
    expect(state.remediation).not.toContain("devices rotate");
  });

  it("shows edge-auth guidance for an identity-proxy rejection", () => {
    const state = resolveGatewayDisconnectState({
      details: { reason: "websocket-upgrade-rejected", httpStatus: 302 },
      reason: "gateway rejected websocket upgrade (HTTP 302)",
    });
    expect(state.activityStatus).toBe("identity-aware proxy rejected connection");
    expect(state.remediation).toContain("gateway.remote.edgeAuth");
  });

  it("falls back to idle for generic disconnect reasons", () => {
    const state = resolveGatewayDisconnectState({ reason: "network timeout" });
    expect(state.connectionStatus).toBe("gateway disconnected: network timeout");
    expect(state.activityStatus).toBe("idle");
    expect(state.remediation).toBeUndefined();
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

  it("treats ASCII BS as backspace when it is the first event", () => {
    withLegacyBackspaceEnv(() => {
      const { dedupe, advance } = createTimedDedupe();

      expect(dedupe("\x08")).toBe("\x08");
      advance(1);
      expect(dedupe("\x7f")).toBe("");
    });
  });

  it.each([
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
  ])("handles $name", ({ input, expected }) => {
    withLegacyBackspaceEnv(() => {
      const { dedupe } = createTimedDedupe();

      expect(input.map(dedupe)).toEqual(expected);
    });
  });

  it("preserves complementary legacy events outside the dedupe window", () => {
    withLegacyBackspaceEnv(() => {
      const { dedupe, advance } = createTimedDedupe();

      expect(dedupe("\x7f")).toBe("\x7f");
      advance(10);
      expect(dedupe("\x08")).toBe("\x08");
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
  it("exits on second ctrl+c within the exit window", () => {
    expect(resolveCtrlCAction({ hasInput: false, now: 2800, lastCtrlCAt: 2000 })).toEqual({
      action: "exit",
      nextLastCtrlCAt: 2000,
    });
  });

  it("shows warning when exit window has elapsed", () => {
    expect(resolveCtrlCAction({ hasInput: false, now: 3501, lastCtrlCAt: 2000 })).toEqual({
      action: "warn",
      nextLastCtrlCAt: 3501,
    });
  });
});

describe("resolveTuiCtrlCAction", () => {
  it("exits immediately after a gateway disconnect", () => {
    expect(
      resolveTuiCtrlCAction({
        hasInput: false,
        now: 2000,
        lastCtrlCAt: 0,
        wasDisconnected: true,
      }),
    ).toEqual({
      action: "exit",
      nextLastCtrlCAt: 0,
    });
  });

  it("clears a nonempty draft before exiting after a gateway disconnect", () => {
    expect(
      resolveTuiCtrlCAction({
        hasInput: true,
        now: 2000,
        lastCtrlCAt: 0,
        wasDisconnected: true,
      }),
    ).toEqual({
      action: "clear",
      nextLastCtrlCAt: 2000,
    });
  });

  it("forces exit when shutdown is already in progress", () => {
    expect(
      resolveTuiCtrlCAction({
        hasInput: true,
        now: 2000,
        lastCtrlCAt: 1000,
        exitRequested: true,
      }),
    ).toEqual({
      action: "force-exit",
      nextLastCtrlCAt: 1000,
    });
  });
});

describe("createTuiConnectionLineage", () => {
  it("keeps a startup retry before the first hello out of reconnect recovery", () => {
    const lineage = createTuiConnectionLineage();

    lineage.disconnect();
    expect(lineage.wasDisconnected()).toBe(false);
    expect(lineage.connect()).toBe(false);

    lineage.disconnect();
    expect(lineage.wasDisconnected()).toBe(true);
    expect(lineage.connect()).toBe(true);
  });
});

describe("TUI shutdown safety", () => {
  const beginTestShutdown = (overrides: Partial<Parameters<typeof beginTuiShutdown>[0]> = {}) =>
    beginTuiShutdown({
      stopClient: vi.fn(),
      stopTui: vi.fn(),
      disposeStatus: vi.fn(),
      requestFinish: vi.fn(),
      forceExit: vi.fn(),
      hardExitMs: 2000,
      keepHardExitArmed: true,
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

    beginTestShutdown({ disposeStatus, keepHardExitArmed: false });

    expect(disposeStatus).toHaveBeenCalledOnce();
    expect(loader.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(0);

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

  it("treats setRawMode EBADF errors as ignorable", () => {
    expect(isIgnorableTuiStopError(new Error("setRawMode EBADF"))).toBe(true);
    expect(
      isIgnorableTuiStopError({
        code: "EBADF",
        syscall: "setRawMode",
      }),
    ).toBe(true);
  });

  it("does not ignore unrelated stop errors", () => {
    expect(isIgnorableTuiStopError(new Error("something else failed"))).toBe(false);
    expect(isIgnorableTuiStopError({ code: "EIO", syscall: "write" })).toBe(false);
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

  it("forces process exit when gateway teardown never settles", async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const requestFinish = vi.fn();
    const timer = beginTestShutdown({
      stopClient: () => new Promise<void>(() => {}),
      requestFinish,
      forceExit: () => process.exit(130),
    });

    expect((timer as NodeJS.Timeout).hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(1999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(130);
    expect(requestFinish).not.toHaveBeenCalled();
  });

  it("keeps the force-exit deadline armed after already-drained teardown settles", async () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    const requestFinish = vi.fn();
    beginTestShutdown({
      requestFinish,
      forceExit,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(requestFinish).toHaveBeenCalledOnce();
    expect(forceExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(forceExit).toHaveBeenCalledOnce();
  });

  it("completes healthy shutdown promptly without waiting for the force-exit deadline", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const forceExit = vi.fn();
    const recordPhase = (phase: string) => async () => {
      calls.push(phase);
    };
    beginTestShutdown({
      stopCommandScopes: recordPhase("scopes"),
      stopClient: recordPhase("client"),
      stopTui: recordPhase("tui"),
      disposeStatus: () => {
        calls.push("status");
      },
      requestFinish: () => {
        calls.push("finish");
      },
      forceExit,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["status", "scopes", "client", "tui", "status", "finish"]);
    expect(forceExit).not.toHaveBeenCalled();
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

    beginTestShutdown({
      stopClient: async () => {
        calls.push("client");
        throw transportError;
      },
      stopTui,
      requestFinish,
      onError,
      keepHardExitArmed: false,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["client", "tui"]);
    expect(vi.getTimerCount()).toBe(1);
    expect(requestFinish).not.toHaveBeenCalled();

    finishTuiStop?.();
    await vi.advanceTimersByTimeAsync(0);
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

    beginTestShutdown({
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

    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledOnce();
    const error = onError.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([scopeError, transportError, terminalError]);
    expect(requestFinish).toHaveBeenCalledOnce();
  });

  it("forces standalone TUI exit on deadline while another handle lingers", () => {
    vi.useFakeTimers();
    const lingeringHandle = setInterval(() => {}, 60_000);
    const exited = new Error("process exited");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw exited;
    });
    const writeStderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const timer = scheduleProcessExitAfterTuiReturn();

    expect(timer.hasRef()).toBe(false);
    vi.advanceTimersByTime(1999);
    expect(exit).not.toHaveBeenCalled();
    expect(() => vi.advanceTimersByTime(1)).toThrow(exited);
    expect(writeStderr).toHaveBeenCalledWith("openclaw tui forcing process exit after return\n");
    expect(exit).toHaveBeenCalledWith(0);
    clearInterval(lingeringHandle);
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

describe("resolveLocalAuthSpawnInvocation", () => {
  it("keeps direct execution for non-wrapper commands", () => {
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
    timeoutMs: 100,
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
    emit(signal: SignalName) {
      for (const handler of listeners.get(signal) ?? []) {
        handler();
      }
    },
  };
}

describe("embedded TUI state ownership", () => {
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
