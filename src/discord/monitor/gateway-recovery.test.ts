import { EventEmitter } from "node:events";
import type { GatewayPlugin } from "@buape/carbon/gateway";
import { describe, expect, it, vi } from "vitest";
import {
  attachDiscordGatewayRecovery,
  DiscordGatewayRecoveryTracker,
  runDiscordGatewayWithOuterRetry,
  shouldRetryDiscordGatewayError,
  shouldStopDiscordGatewayError,
} from "./gateway-recovery.js";

const makeRuntime = () => ({
  log: vi.fn(),
  error: vi.fn(),
});

describe("DiscordGatewayRecoveryTracker", () => {
  it("trips after 3 consecutive resume failures and forces fresh identify", () => {
    const disconnect = vi.fn();
    const connect = vi.fn();
    const mutableGateway = {
      disconnect,
      connect,
      state: {
        sessionId: "session",
        resumeGatewayUrl: "wss://resume.discord.gg",
        sequence: 88,
      },
      sequence: 88,
      pings: [12, 40],
    };
    const gateway = mutableGateway as unknown as GatewayPlugin;

    const tracker = new DiscordGatewayRecoveryTracker({
      gateway,
      policy: { maxConsecutiveResumeFailures: 3, resetWindowMs: 60_000 },
    });

    expect(tracker.handleDebugMessage("Attempting resume with backoff: 1000ms").tripped).toBe(
      false,
    );
    expect(tracker.handleDebugMessage("WebSocket connection closed with code 1005").tripped).toBe(
      false,
    );
    expect(tracker.handleDebugMessage("Attempting resume with backoff: 2000ms").tripped).toBe(
      false,
    );
    expect(tracker.handleDebugMessage("WebSocket connection closed with code 1005").tripped).toBe(
      false,
    );
    expect(tracker.handleDebugMessage("Attempting resume with backoff: 4000ms").tripped).toBe(
      false,
    );
    expect(tracker.handleDebugMessage("WebSocket connection closed with code 1005").tripped).toBe(
      true,
    );

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(false);
    expect(mutableGateway.state.sessionId).toBeNull();
    expect(mutableGateway.state.resumeGatewayUrl).toBeNull();
    expect(mutableGateway.state.sequence).toBeNull();
    expect(mutableGateway.sequence).toBeNull();
    expect(mutableGateway.pings).toEqual([]);
    expect(tracker.getState().consecutiveResumeFailures).toBe(0);
  });

  it("resets failures when connection is marked stable", () => {
    const gateway = {
      disconnect: vi.fn(),
      connect: vi.fn(),
      state: { sessionId: "s", resumeGatewayUrl: "u", sequence: 1 },
      sequence: 1,
      pings: [],
    } as unknown as GatewayPlugin;

    const tracker = new DiscordGatewayRecoveryTracker({ gateway });

    tracker.handleDebugMessage("Attempting resume with backoff: 1000ms");
    tracker.handleDebugMessage("WebSocket connection closed with code 1005");
    expect(tracker.getState().consecutiveResumeFailures).toBe(1);

    tracker.handleDebugMessage("connection stable after 30s");
    expect(tracker.getState().consecutiveResumeFailures).toBe(0);
    expect(tracker.getState().isResuming).toBe(false);
  });

  it("resets failure window after expiry", () => {
    let nowMs = 0;
    const gateway = {
      disconnect: vi.fn(),
      connect: vi.fn(),
      state: { sessionId: "s", resumeGatewayUrl: "u", sequence: 1 },
      sequence: 1,
      pings: [],
    } as unknown as GatewayPlugin;

    const tracker = new DiscordGatewayRecoveryTracker({
      gateway,
      policy: { maxConsecutiveResumeFailures: 3, resetWindowMs: 100 },
      now: () => nowMs,
    });

    tracker.handleDebugMessage("Attempting resume with backoff: 1000ms");
    tracker.handleDebugMessage("WebSocket connection closed with code 1005");
    expect(tracker.getState().consecutiveResumeFailures).toBe(1);

    nowMs = 150;
    tracker.handleDebugMessage("Attempting resume with backoff: 2000ms");
    tracker.handleDebugMessage("WebSocket connection closed with code 1005");
    expect(tracker.getState().consecutiveResumeFailures).toBe(1);
  });

  it("counts rollover resume attempts as failures when close marker is missing", () => {
    const gateway = {
      disconnect: vi.fn(),
      connect: vi.fn(),
      state: { sessionId: "s", resumeGatewayUrl: "u", sequence: 1 },
      sequence: 1,
      pings: [],
    } as unknown as GatewayPlugin;

    const tracker = new DiscordGatewayRecoveryTracker({ gateway });

    tracker.handleDebugMessage("Attempting resume with backoff: 1000ms");
    tracker.handleDebugMessage("Attempting resume with backoff: 2000ms");

    expect(tracker.getState().consecutiveResumeFailures).toBe(1);
    expect(tracker.getState().isResuming).toBe(true);
  });

  it("ignores recovery messages while shutdown is in progress", () => {
    const emitter = new EventEmitter();
    let shuttingDown = true;
    const disconnect = vi.fn();
    const connect = vi.fn();
    const gateway = {
      disconnect,
      connect,
      state: { sessionId: "s", resumeGatewayUrl: "u", sequence: 1 },
      sequence: 1,
      pings: [],
    } as unknown as GatewayPlugin;

    const stopRecovery = attachDiscordGatewayRecovery({
      emitter,
      gateway,
      runtime: makeRuntime(),
      shouldIgnoreMessage: () => shuttingDown,
    });

    emitter.emit("debug", "Attempting resume with backoff: 1000ms");
    emitter.emit("debug", "WebSocket connection closed with code 1005");
    emitter.emit("debug", "Attempting resume with backoff: 2000ms");
    emitter.emit("debug", "WebSocket connection closed with code 1005");
    emitter.emit("debug", "Attempting resume with backoff: 4000ms");
    emitter.emit("debug", "WebSocket connection closed with code 1005");

    expect(disconnect).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();

    shuttingDown = false;
    stopRecovery();
  });
});

describe("runDiscordGatewayWithOuterRetry", () => {
  it("retries only on max-reconnect errors, not fatal gateway errors", () => {
    expect(shouldRetryDiscordGatewayError(new Error("Max reconnect attempts (50) reached"))).toBe(
      true,
    );
    expect(shouldRetryDiscordGatewayError(new Error("Fatal Gateway error: 4014"))).toBe(false);
    expect(shouldStopDiscordGatewayError(new Error("Max reconnect attempts (50) reached"))).toBe(
      true,
    );
    expect(shouldStopDiscordGatewayError(new Error("Fatal Gateway error: 4014"))).toBe(true);
  });

  it("retries with backoff and succeeds before exhaustion", async () => {
    const runtime = makeRuntime();
    const runOnce = vi
      .fn(async (_outerAttempt: number) => {})
      .mockRejectedValueOnce(new Error("Max reconnect attempts"))
      .mockRejectedValueOnce(new Error("Max reconnect attempts"))
      .mockResolvedValueOnce(undefined);
    const sleep = vi
      .fn(async (_ms: number, _signal?: AbortSignal) => {})
      .mockResolvedValue(undefined);
    const computeDelay = vi
      .fn(
        (
          _policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
          _attempt: number,
        ) => 0,
      )
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(2000);

    await runDiscordGatewayWithOuterRetry({
      runtime,
      runOnce,
      sleep,
      computeDelay,
      policy: {
        maxOuterRetries: 5,
      },
    });

    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(computeDelay).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        initialMs: 10_000,
        maxMs: 120_000,
        factor: 1.8,
        jitter: 0.2,
      }),
      1,
    );
    expect(computeDelay).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        initialMs: 10_000,
        maxMs: 120_000,
        factor: 1.8,
        jitter: 0.2,
      }),
      2,
    );
  });

  it("exits cleanly when abort happens during backoff sleep", async () => {
    const runtime = makeRuntime();
    const abort = new AbortController();
    const runOnce = vi
      .fn(async (_outerAttempt: number) => {})
      .mockRejectedValue(new Error("Max reconnect attempts"));
    const sleep = vi
      .fn(async (_ms: number, _signal?: AbortSignal) => {})
      .mockImplementationOnce(async () => {
        abort.abort();
        throw new Error("aborted");
      });

    await expect(
      runDiscordGatewayWithOuterRetry({
        runtime,
        runOnce,
        sleep,
        abortSignal: abort.signal,
      }),
    ).resolves.toBeUndefined();

    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("throws deterministic exhaustion error after max retries", async () => {
    const runtime = makeRuntime();
    const runOnce = vi
      .fn(async (_outerAttempt: number) => {})
      .mockRejectedValue(new Error("Max reconnect attempts"));
    const sleep = vi
      .fn(async (_ms: number, _signal?: AbortSignal) => {})
      .mockResolvedValue(undefined);

    await expect(
      runDiscordGatewayWithOuterRetry({
        runtime,
        runOnce,
        sleep,
        policy: { maxOuterRetries: 2 },
      }),
    ).rejects.toThrow("discord: gateway failed after 2 outer retries — marking channel as dead");

    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
