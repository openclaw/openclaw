import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionObserverDigestSchema,
  type SessionObserverDigest,
} from "../../packages/gateway-protocol/src/schema/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { normalizeSessionObserverModelOutput } from "./session-observer-model.js";
import { createSessionObserver } from "./session-observer.js";

const cfg = {
  gateway: { controlUi: { sessionObserver: true } },
  agents: { defaults: { utilityModel: "openai/gpt-test" } },
} satisfies OpenClawConfig;

let eventSequence = 0;

function event(params: {
  runId?: string;
  sessionKey?: string;
  agentId?: string;
  stream: string;
  data: Record<string, unknown>;
}): AgentEventPayload {
  eventSequence += 1;
  return {
    runId: params.runId ?? "run-1",
    sessionKey: params.sessionKey ?? "agent:main:session-1",
    agentId: params.agentId ?? "main",
    seq: eventSequence,
    ts: Date.now(),
    stream: params.stream,
    data: params.data,
  };
}

function modelMessage(value: Record<string, unknown>) {
  return {
    stopReason: "stop",
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function preparedModel() {
  return {
    selection: { provider: "openai", modelId: "gpt-test", agentDir: "/tmp/agent" },
    model: { provider: "openai", id: "gpt-test", maxTokens: 8_192 },
    auth: { apiKey: "test-api-key", mode: "api-key" },
  };
}

function persistedLiveDigest(
  overrides: Partial<SessionObserverDigest> = {},
): SessionObserverDigest {
  return {
    sessionKey: "agent:main:session-1",
    runId: "run-1",
    revision: 7,
    updatedAt: 1_000,
    headline: "Still working",
    assessment: "The run is making progress.",
    health: "on-track",
    planProgress: { completed: 1, total: 3 },
    ...overrides,
  };
}

async function flushObserver(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

function createHarness(options?: {
  subscribe?: boolean;
  completeModel?: ReturnType<typeof vi.fn>;
  prepareModel?: ReturnType<typeof vi.fn>;
  persistDigest?: ReturnType<typeof vi.fn>;
  readSession?: ReturnType<typeof vi.fn>;
  config?: OpenClawConfig;
  utilityModelRef?: string | null;
  resolveUtilityModelRef?: ReturnType<typeof vi.fn>;
}) {
  const subscribers = createSessionMessageSubscriberRegistry();
  if (options?.subscribe !== false) {
    subscribers.subscribe("conn-1", "agent:main:session-1")?.commit();
  }
  const prepareModel = options?.prepareModel ?? vi.fn(async () => preparedModel());
  const completeModel =
    options?.completeModel ??
    vi.fn(async () =>
      modelMessage({
        headline: "Reviewing the implementation",
        assessment: "The work is progressing steadily.",
        health: "on-track",
      }),
    );
  const broadcastToConnIds = vi.fn();
  const persistDigest = options?.persistDigest ?? vi.fn(async () => true);
  const readSession =
    options?.readSession ?? vi.fn(() => ({ sessionId: "session-id", updatedAt: 0 }));
  const observer = createSessionObserver({
    getConfig: () => options?.config ?? cfg,
    subscribers,
    broadcastToConnIds,
    resolveUtilityModelRef: (options?.resolveUtilityModelRef ??
      (() =>
        options?.utilityModelRef === null
          ? undefined
          : (options?.utilityModelRef ?? "openai/gpt-test"))) as never,
    prepareModel: prepareModel as never,
    completeModel: completeModel as never,
    readSession: readSession as never,
    persistDigest: persistDigest as never,
  });
  return {
    observer,
    subscribers,
    prepareModel,
    completeModel,
    broadcastToConnIds,
    persistDigest,
    readSession,
  };
}

function startAndAddToolNotes(
  observer: ReturnType<typeof createSessionObserver>,
  params: { runId?: string; sessionKey?: string; count?: number } = {},
) {
  const runId = params.runId ?? "run-1";
  const sessionKey = params.sessionKey ?? "agent:main:session-1";
  observer.handleEvent(event({ runId, sessionKey, stream: "lifecycle", data: { phase: "start" } }));
  for (let index = 0; index < (params.count ?? 3); index += 1) {
    observer.handleEvent(
      event({
        runId,
        sessionKey,
        stream: "tool",
        data: { phase: "start", name: "read", args: { path: `src/file-${index}.ts` } },
      }),
    );
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  eventSequence = 0;
});

describe("session observer", () => {
  it("waits for four notes and twelve seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(11_999);
    expect(harness.completeModel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushObserver();
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.subscribers.get("agent:main:session-1")).toHaveLength(1);
    expect(harness.prepareModel).toHaveBeenCalledOnce();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    harness.observer.dispose();
  });

  it("never includes tool results or command output and redacts tool arguments", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    const runtimeDetail = "runtime-detail-that-must-not-leave";
    const commandOutput = "command-output-that-must-not-leave";
    const toolCommand = ["password", "test-password"].join("=");

    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));
    harness.observer.handleEvent(
      event({
        stream: "tool",
        data: {
          phase: "start",
          name: "exec",
          args: { token: "test-token", command: toolCommand, content: runtimeDetail },
        },
      }),
    );
    harness.observer.handleEvent(
      event({
        stream: "tool",
        data: { phase: "result", result: { content: "ok", details: runtimeDetail } },
      }),
    );
    harness.observer.handleEvent(
      event({
        stream: "command_output",
        data: {
          phase: "end",
          title: "Command",
          status: "failed",
          exitCode: 1,
          output: commandOutput,
        },
      }),
    );
    harness.observer.handleEvent(
      event({ stream: "tool", data: { phase: "start", name: "read", args: { path: "a" } } }),
    );
    harness.observer.handleEvent(
      event({ stream: "tool", data: { phase: "start", name: "read", args: { path: "b" } } }),
    );

    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    const prompt = String(
      harness.completeModel.mock.calls[0]?.[0]?.context?.messages?.[0]?.content,
    );
    expect(prompt).not.toContain("test-token");
    expect(prompt).not.toContain(runtimeDetail);
    expect(prompt).not.toContain(commandOutput);
    expect(prompt).not.toContain(toolCommand);
    expect(prompt).toContain("***");
    harness.observer.dispose();
  });

  it("coalesces a burst behind one in-flight completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolveFirst: ((value: ReturnType<typeof modelMessage>) => void) | undefined;
    const completeModel = vi.fn(
      () =>
        new Promise<ReturnType<typeof modelMessage>>((resolve) => {
          resolveFirst ??= resolve;
          if (completeModel.mock.calls.length > 1) {
            resolve(modelMessage({ headline: "Continuing the work", health: "on-track" }));
          }
        }),
    );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(completeModel).toHaveBeenCalledOnce();

    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({
          stream: "tool",
          data: { phase: "start", name: "read", args: { path: `burst-${index}` } },
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(9_000);
    expect(completeModel).toHaveBeenCalledOnce();

    resolveFirst?.(modelMessage({ headline: "Starting the work", health: "on-track" }));
    await flushObserver();
    expect(completeModel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushObserver();
    expect(completeModel).toHaveBeenCalledTimes(2);
    harness.observer.dispose();
  });

  it("does not start completion after observation ends during model preparation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolvePreparation: ((value: ReturnType<typeof preparedModel>) => void) | undefined;
    const prepareModel = vi.fn(
      () =>
        new Promise<ReturnType<typeof preparedModel>>((resolve) => {
          resolvePreparation = resolve;
        }),
    );
    const harness = createHarness({ prepareModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(prepareModel).toHaveBeenCalledOnce();

    harness.subscribers.unsubscribe("conn-1", "agent:main:session-1");
    resolvePreparation?.(preparedModel());
    await flushObserver();

    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("times out stalled model preparation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const prepareModel = vi.fn(
      () =>
        new Promise<never>(() => {
          // Intentionally unresolved: the observer timeout owns this test path.
        }),
    );
    const harness = createHarness({ prepareModel });
    startAndAddToolNotes(harness.observer);

    await vi.advanceTimersByTimeAsync(34_000);
    await flushObserver();

    expect(prepareModel).toHaveBeenCalledOnce();
    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("reserves the fortieth digest for the terminal status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));

    for (let digest = 0; digest < 40; digest += 1) {
      for (let note = 0; note < 4; note += 1) {
        harness.observer.handleEvent(
          event({
            stream: "tool",
            data: { phase: "start", name: "read", args: { path: `${digest}-${note}` } },
          }),
        );
      }
      await vi.advanceTimersByTimeAsync(12_000);
      await flushObserver();
    }

    expect(harness.completeModel).toHaveBeenCalledTimes(39);
    expect(harness.broadcastToConnIds).toHaveBeenCalledTimes(39);

    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: Date.now() },
      }),
    );
    await flushObserver();

    expect(harness.completeModel).toHaveBeenCalledTimes(40);
    expect(harness.broadcastToConnIds).toHaveBeenCalledTimes(40);
    const finalDigest = harness.broadcastToConnIds.mock.calls.at(-1)?.[1] as
      | SessionObserverDigest
      | undefined;
    expect(finalDigest?.health).toBe("done");
    harness.observer.dispose();
  });

  it("disables a run after two consecutive model failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const completeModel = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);

    await vi.advanceTimersByTimeAsync(24_000);
    await flushObserver();
    expect(completeModel).toHaveBeenCalledTimes(2);

    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { index } } }),
      );
    }
    await vi.advanceTimersByTimeAsync(24_000);
    expect(completeModel).toHaveBeenCalledTimes(2);
    harness.observer.dispose();
  });

  it("does not observe without subscribers and stops after unsubscribe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const unsubscribed = createHarness({ subscribe: false });
    startAndAddToolNotes(unsubscribed.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(unsubscribed.completeModel).not.toHaveBeenCalled();
    unsubscribed.observer.dispose();

    const subscribed = createHarness();
    startAndAddToolNotes(subscribed.observer);
    subscribed.subscribers.unsubscribe("conn-1", "agent:main:session-1");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(subscribed.completeModel).not.toHaveBeenCalled();
    subscribed.observer.dispose();
  });

  it("does not observe when the agent has no utility model", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness({ utilityModelRef: null });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);

    expect(harness.prepareModel).not.toHaveBeenCalled();
    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("drops scheduled work when observation is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runtimeCfg = {
      gateway: { controlUi: { sessionObserver: true as boolean } },
      agents: { defaults: { utilityModel: "openai/gpt-test" } },
    } satisfies OpenClawConfig;
    const harness = createHarness({ config: runtimeCfg });
    startAndAddToolNotes(harness.observer);

    runtimeCfg.gateway.controlUi.sessionObserver = false;
    await vi.advanceTimersByTimeAsync(12_000);

    expect(harness.prepareModel).not.toHaveBeenCalled();
    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("drops scheduled work when the utility model is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let utilityModelRef: string | undefined = "openai/gpt-test";
    const resolveUtilityModelRef = vi.fn(() => utilityModelRef);
    const harness = createHarness({ resolveUtilityModelRef });
    startAndAddToolNotes(harness.observer);
    utilityModelRef = undefined;
    await vi.advanceTimersByTimeAsync(12_000);

    expect(harness.prepareModel).not.toHaveBeenCalled();
    expect(harness.completeModel).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("retries one unparseable model response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const completeModel = vi
      .fn()
      .mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "text", text: "nope" }] })
      .mockResolvedValueOnce(
        modelMessage({ headline: "Continuing after a retry", health: "on-track" }),
      );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    expect(completeModel).toHaveBeenCalledTimes(2);
    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
    harness.observer.dispose();
  });

  it("evicts the least recently active session at the concurrency cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    for (let index = 0; index < 7; index += 1) {
      const sessionKey = `agent:main:session-${index}`;
      harness.subscribers.subscribe(`conn-${index}`, sessionKey)?.commit();
      vi.setSystemTime(index);
      startAndAddToolNotes(harness.observer, {
        runId: `run-${index}`,
        sessionKey,
      });
    }

    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    const sessions = harness.broadcastToConnIds.mock.calls.map(
      (call) => (call[1] as SessionObserverDigest).sessionKey,
    );
    expect(sessions).toHaveLength(6);
    expect(sessions).not.toContain("agent:main:session-0");
    harness.observer.dispose();
  });

  it("preserves revision continuity when an observed run is evicted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { index } } }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    for (let index = 2; index <= 7; index += 1) {
      const sessionKey = `agent:main:session-${index}`;
      harness.subscribers.subscribe(`conn-${index}`, sessionKey)?.commit();
      vi.setSystemTime(24_000 + index);
      harness.observer.handleEvent(
        event({
          runId: `run-${index}`,
          sessionKey,
          stream: "lifecycle",
          data: { phase: "start" },
        }),
      );
    }

    vi.setSystemTime(30_000);
    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    const revisions = harness.broadcastToConnIds.mock.calls
      .map((call) => call[1] as SessionObserverDigest)
      .filter((digest) => digest.sessionKey === "agent:main:session-1")
      .map((digest) => digest.revision);
    expect(revisions).toEqual([1, 2, 3]);
    harness.observer.dispose();
  });

  it("preserves revision continuity across run rollover", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { index } } }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    harness.observer.handleEvent(
      event({ runId: "run-2", stream: "lifecycle", data: { phase: "start" } }),
    );
    for (let index = 0; index < 3; index += 1) {
      harness.observer.handleEvent(
        event({
          runId: "run-2",
          stream: "tool",
          data: { phase: "start", name: "read", args: { index } },
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    const revisions = harness.broadcastToConnIds.mock.calls.map(
      (call) => (call[1] as SessionObserverDigest).revision,
    );
    expect(revisions).toEqual([1, 2, 3]);
    harness.observer.dispose();
  });

  it("retains the revision floor when a new run starts without subscribers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { index } } }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    harness.subscribers.unsubscribe("conn-1", "agent:main:session-1");
    harness.observer.handleEvent(
      event({ runId: "run-2", stream: "lifecycle", data: { phase: "start" } }),
    );
    harness.subscribers.subscribe("conn-2", "agent:main:session-1")?.commit();
    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({
          runId: "run-2",
          stream: "tool",
          data: { phase: "start", name: "read", args: { index } },
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    const revisions = harness.broadcastToConnIds.mock.calls.map(
      (call) => (call[1] as SessionObserverDigest).revision,
    );
    expect(revisions).toEqual([1, 2, 3]);
    harness.observer.dispose();
  });

  it("ignores late events from a superseded run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const storedDigest = persistedLiveDigest();
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: storedDigest,
    }));
    const harness = createHarness({ readSession });
    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));
    harness.observer.handleEvent(
      event({ runId: "run-2", stream: "lifecycle", data: { phase: "start" } }),
    );
    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    for (let index = 0; index < 3; index += 1) {
      harness.observer.handleEvent(
        event({
          runId: "run-2",
          stream: "tool",
          data: { phase: "start", name: "read", args: { index } },
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
    const digest = harness.broadcastToConnIds.mock.calls[0]?.[1] as
      | SessionObserverDigest
      | undefined;
    expect(digest?.runId).toBe("run-2");
    expect(digest?.health).toBe("on-track");
    expect(digest?.revision).toBe(storedDigest.revision + 1);
    expect(harness.persistDigest).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it.each([
    { phase: "end", expected: "done" },
    { phase: "error", expected: "failed" },
  ])(
    "synthesizes $expected from a persisted live digest without subscribers",
    async ({ phase, expected }) => {
      vi.useFakeTimers();
      vi.setSystemTime(30_000);
      const storedDigest = persistedLiveDigest();
      const readSession = vi.fn(() => ({
        sessionId: "session-id",
        updatedAt: 1_000,
        observerDigest: storedDigest,
      }));
      const harness = createHarness({ subscribe: false, readSession });

      harness.observer.handleEvent(
        event({
          stream: "lifecycle",
          data: { phase, startedAt: 0, endedAt: 30_000, error: "test failure" },
        }),
      );
      await flushObserver();

      expect(harness.completeModel).not.toHaveBeenCalled();
      expect(harness.persistDigest).toHaveBeenCalledOnce();
      const synthesized = harness.persistDigest.mock.calls[0]?.[0]?.digest as
        | SessionObserverDigest
        | undefined;
      expect(synthesized).toMatchObject({
        headline: storedDigest.headline,
        assessment: storedDigest.assessment,
        planProgress: storedDigest.planProgress,
        runId: "run-1",
        health: expected,
        revision: storedDigest.revision + 1,
        updatedAt: 30_000,
      });
      harness.observer.dispose();
    },
  );

  it("does not synthesize a terminal digest from another run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: persistedLiveDigest({ runId: "another-run" }),
    }));
    const harness = createHarness({ subscribe: false, readSession });

    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    expect(harness.persistDigest).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("retries synthesized terminal persistence once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const storedDigest = persistedLiveDigest();
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: storedDigest,
    }));
    const persistDigest = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary write failure"))
      .mockResolvedValueOnce(true);
    const harness = createHarness({ subscribe: false, persistDigest, readSession });

    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    expect(persistDigest).toHaveBeenCalledTimes(2);
    const synthesized = persistDigest.mock.calls[1]?.[0]?.digest as
      | SessionObserverDigest
      | undefined;
    expect(synthesized?.health).toBe("done");
    harness.observer.dispose();
  });

  it("synthesizes terminal health for a disabled run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const storedDigest = persistedLiveDigest({ health: "waiting-on-user" });
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: storedDigest,
    }));
    const completeModel = vi
      .fn()
      .mockResolvedValueOnce(modelMessage({ headline: "Latest live headline", health: "on-track" }))
      .mockRejectedValueOnce(new Error("first model failure"))
      .mockRejectedValueOnce(new Error("second model failure"));
    const harness = createHarness({ completeModel, readSession });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { index } } }),
      );
    }
    await vi.advanceTimersByTimeAsync(24_000);
    await flushObserver();

    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "error", startedAt: 0, endedAt: 36_000, error: "run failed" },
      }),
    );
    await flushObserver();

    expect(completeModel).toHaveBeenCalledTimes(3);
    const synthesized = harness.persistDigest.mock.calls[0]?.[0]?.digest as
      | SessionObserverDigest
      | undefined;
    expect(synthesized).toMatchObject({
      headline: "Latest live headline",
      health: "failed",
      revision: storedDigest.revision + 2,
    });
    harness.observer.dispose();
  });

  it("synthesizes terminal health when config disables terminal admission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const runtimeCfg = {
      gateway: { controlUi: { sessionObserver: true as boolean } },
      agents: { defaults: { utilityModel: "openai/gpt-test" } },
    } satisfies OpenClawConfig;
    const storedDigest = persistedLiveDigest();
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: storedDigest,
    }));
    const harness = createHarness({ config: runtimeCfg, readSession });
    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));
    runtimeCfg.gateway.controlUi.sessionObserver = false;

    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    expect(harness.completeModel).not.toHaveBeenCalled();
    const synthesized = harness.persistDigest.mock.calls[0]?.[0]?.digest as
      | SessionObserverDigest
      | undefined;
    expect(synthesized).toMatchObject({
      headline: storedDigest.headline,
      health: "done",
      revision: storedDigest.revision + 1,
    });
    harness.observer.dispose();
  });

  it("synthesizes before dropping an in-flight terminal state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const storedDigest = persistedLiveDigest();
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: storedDigest,
    }));
    const completeModel = vi.fn(
      () =>
        new Promise<never>(() => {
          // Intentionally unresolved until the observer aborts this terminal call.
        }),
    );
    const harness = createHarness({ completeModel, readSession });
    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();
    expect(completeModel).toHaveBeenCalledOnce();

    harness.subscribers.unsubscribe("conn-1", "agent:main:session-1");
    await flushObserver();

    const synthesized = harness.persistDigest.mock.calls[0]?.[0]?.digest as
      | SessionObserverDigest
      | undefined;
    expect(synthesized).toMatchObject({
      headline: storedDigest.headline,
      health: "done",
      revision: storedDigest.revision + 1,
    });
    harness.observer.dispose();
  });

  it("synthesizes terminal health after final model retries fail", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const storedDigest = persistedLiveDigest({ health: "failed" });
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: storedDigest,
    }));
    const completeModel = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const harness = createHarness({ completeModel, readSession });

    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    expect(completeModel).toHaveBeenCalledTimes(2);
    expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
    const synthesized = harness.persistDigest.mock.calls[0]?.[0]?.digest as
      | SessionObserverDigest
      | undefined;
    expect(synthesized).toMatchObject({
      headline: storedDigest.headline,
      assessment: storedDigest.assessment,
      planProgress: storedDigest.planProgress,
      health: "done",
      revision: storedDigest.revision + 1,
      updatedAt: 30_000,
    });
    harness.observer.dispose();
  });

  it("synthesizes a queued terminal when a live call reaches the failure limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const storedDigest = persistedLiveDigest();
    const readSession = vi.fn(() => ({
      sessionId: "session-id",
      updatedAt: 1_000,
      observerDigest: storedDigest,
    }));
    let rejectSecond: ((error: Error) => void) | undefined;
    const completeModel = vi
      .fn()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockImplementationOnce(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectSecond = reject;
          }),
      );
    const harness = createHarness({ completeModel, readSession });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(24_000);
    expect(completeModel).toHaveBeenCalledTimes(2);

    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 24_000 },
      }),
    );
    rejectSecond?.(new Error("second failure"));
    await flushObserver();

    const synthesized = harness.persistDigest.mock.calls[0]?.[0]?.digest as
      | SessionObserverDigest
      | undefined;
    expect(synthesized).toMatchObject({
      headline: storedDigest.headline,
      health: "done",
      revision: storedDigest.revision + 1,
    });
    harness.observer.dispose();
  });

  it("produces a terminal digest when subscribing late in a long run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const harness = createHarness();
    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    const digest = harness.broadcastToConnIds.mock.calls[0]?.[1] as
      | SessionObserverDigest
      | undefined;
    expect(digest?.health).toBe("done");
    harness.observer.dispose();
  });

  it.each([
    { phase: "end", expected: "done" },
    { phase: "error", expected: "failed" },
  ])("forces $expected health on a terminal lifecycle digest", async ({ phase, expected }) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));
    await vi.advanceTimersByTimeAsync(30_000);
    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase, startedAt: 0, endedAt: 30_000, error: "test failure" },
      }),
    );
    await flushObserver();

    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
    const digest = harness.broadcastToConnIds.mock.calls[0]?.[1] as
      | SessionObserverDigest
      | undefined;
    expect(digest?.health).toBe(expected);
    expect(harness.persistDigest).toHaveBeenCalledOnce();
    harness.observer.dispose();
  });

  it("retries one transient terminal digest failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const completeModel = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(modelMessage({ headline: "Finished the work", health: "on-track" }));
    const harness = createHarness({ completeModel });
    harness.observer.handleEvent(event({ stream: "lifecycle", data: { phase: "start" } }));
    await vi.advanceTimersByTimeAsync(30_000);
    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    expect(completeModel).toHaveBeenCalledTimes(2);
    const digest = harness.broadcastToConnIds.mock.calls[0]?.[1] as
      | SessionObserverDigest
      | undefined;
    expect(digest?.health).toBe("done");
    expect(harness.persistDigest).toHaveBeenCalledOnce();
    harness.observer.dispose();
  });

  it("retries failed terminal persistence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const persistDigest = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary write failure"))
      .mockResolvedValueOnce(true);
    const harness = createHarness({ persistDigest });
    harness.observer.handleEvent(
      event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 30_000 },
      }),
    );
    await flushObserver();

    expect(persistDigest).toHaveBeenCalledTimes(2);
    harness.observer.dispose();
  });

  it("does not throttle persistence after a failed live write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const persistDigest = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary write failure"))
      .mockResolvedValueOnce(true);
    const harness = createHarness({ persistDigest });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    for (let index = 0; index < 4; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { index } } }),
      );
    }
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();

    expect(persistDigest).toHaveBeenCalledTimes(2);
    harness.observer.dispose();
  });

  it("redacts secrets split across assistant deltas in the assembled note", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    harness.observer.handleEvent(
      event({ stream: "assistant", data: { delta: "Calling the API with api_k" } }),
    );
    harness.observer.handleEvent(
      event({ stream: "assistant", data: { delta: "ey=super-secret-value-0123456789 attached." } }),
    );
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const prompt = JSON.stringify(
      harness.completeModel.mock.calls[0]?.[0]?.context?.messages ?? [],
    );
    expect(prompt).toContain("Assistant:");
    expect(prompt).not.toContain("super-secret-value-0123456789");
    harness.observer.dispose();
  });

  it("does not count assistant fragments toward the note threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer, { count: 2 });
    for (let index = 0; index < 6; index += 1) {
      harness.observer.handleEvent(
        event({ stream: "assistant", data: { delta: `progress fragment ${index} ` } }),
      );
    }
    await vi.advanceTimersByTimeAsync(20_000);
    await flushObserver();
    expect(harness.completeModel).not.toHaveBeenCalled();

    harness.observer.handleEvent(
      event({
        stream: "tool",
        data: { phase: "start", name: "read", args: { path: "src/final.ts" } },
      }),
    );
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    harness.observer.dispose();
  });

  it("prefers cumulative assistant text and emits a single assembled note", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    harness.observer.handleEvent(
      event({ stream: "assistant", data: { delta: "Working on the f" } }),
    );
    harness.observer.handleEvent(event({ stream: "assistant", data: { delta: "ix" } }));
    harness.observer.handleEvent(
      event({ stream: "assistant", data: { text: "Working on the fix and verifying it." } }),
    );
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const prompt = JSON.stringify(
      harness.completeModel.mock.calls[0]?.[0]?.context?.messages ?? [],
    );
    expect(prompt.match(/Assistant:/gu)).toHaveLength(1);
    expect(prompt).toContain("Working on the fix and verifying it.");
    harness.observer.dispose();
  });

  it("broadcasts a synthesized terminal digest when the final model call keeps failing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const completeModel = vi.fn(async () =>
      modelMessage({ headline: "Fixing tests", health: "grinding" }),
    );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();

    completeModel.mockRejectedValue(new Error("model unavailable"));
    harness.observer.handleEvent(
      event({ stream: "lifecycle", data: { phase: "end", endedAt: 60_000 } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await flushObserver();
    const observerCalls = harness.broadcastToConnIds.mock.calls.filter(
      (call) => call[0] === "session.observer",
    );
    expect(observerCalls).toHaveLength(2);
    const synthesized = observerCalls.at(-1)?.[1] as SessionObserverDigest;
    expect(synthesized.health).toBe("done");
    expect(synthesized.headline).toBe("Fixing tests");
    expect(synthesized.revision).toBe(2);
    expect(harness.persistDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        digest: expect.objectContaining({ health: "done", revision: 2 }),
      }),
    );
    harness.observer.dispose();
  });

  it("does not persist a synthesized terminal digest for a superseded run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const completeModel = vi.fn(async () =>
      modelMessage({ headline: "Fixing tests", health: "grinding" }),
    );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();

    completeModel.mockImplementation(() => new Promise(() => {}));
    harness.observer.handleEvent(
      event({ stream: "lifecycle", data: { phase: "end", endedAt: 30_000 } }),
    );
    harness.observer.handleEvent(
      event({ runId: "run-2", stream: "lifecycle", data: { phase: "start" } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await flushObserver();
    const persistedTerminal = harness.persistDigest.mock.calls.filter(
      (call) => call[0]?.digest?.runId === "run-1" && call[0]?.digest?.health !== "grinding",
    );
    expect(persistedTerminal).toHaveLength(0);
    const terminalBroadcasts = harness.broadcastToConnIds.mock.calls.filter(
      (call) =>
        call[0] === "session.observer" &&
        (call[1] as SessionObserverDigest | undefined)?.runId === "run-1" &&
        (call[1] as SessionObserverDigest | undefined)?.health === "done",
    );
    expect(terminalBroadcasts).toHaveLength(0);
    harness.observer.dispose();
  });

  it("invalidates the persist-time guard when a newer run replaces the digest's run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const persistDigest = vi.fn(async () => undefined);
    const harness = createHarness({ persistDigest });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(persistDigest).toHaveBeenCalledOnce();
    const guard = persistDigest.mock.calls[0]?.[0]?.stillCurrent as (() => boolean) | undefined;
    expect(guard?.()).toBe(true);

    harness.observer.handleEvent(
      event({ runId: "run-2", stream: "lifecycle", data: { phase: "start" } }),
    );
    expect(guard?.()).toBe(false);
    harness.observer.dispose();
  });

  it("drops a completed digest when the session was reset mid-flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const readSession = vi.fn(() => ({ sessionId: "session-id", updatedAt: 0 }));
    const harness = createHarness({ readSession });
    startAndAddToolNotes(harness.observer);
    readSession.mockReturnValue({ sessionId: "session-id-reset", updatedAt: 0 });
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const observerBroadcasts = harness.broadcastToConnIds.mock.calls.filter(
      (call) => call[0] === "session.observer",
    );
    expect(observerBroadcasts).toHaveLength(0);
    expect(harness.persistDigest).not.toHaveBeenCalled();
    harness.observer.dispose();
  });

  it("catches up durable persistence when the live digest already carried terminal health", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const completeModel = vi.fn(async () =>
      modelMessage({ headline: "Finished the fix", health: "done" }),
    );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const liveBroadcasts = harness.broadcastToConnIds.mock.calls.filter(
      (call) => call[0] === "session.observer",
    );
    expect(liveBroadcasts).toHaveLength(1);

    completeModel.mockRejectedValue(new Error("model unavailable"));
    harness.observer.handleEvent(
      event({ stream: "lifecycle", data: { phase: "end", endedAt: 30_000 } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await flushObserver();
    const persisted = harness.persistDigest.mock.calls.at(-1)?.[0]?.digest as
      | SessionObserverDigest
      | undefined;
    expect(persisted?.health).toBe("done");
    expect(persisted?.revision).toBe(1);
    const observerBroadcasts = harness.broadcastToConnIds.mock.calls.filter(
      (call) => call[0] === "session.observer",
    );
    expect(observerBroadcasts).toHaveLength(1);
    harness.observer.dispose();
  });

  it("does not broadcast a synthesized terminal digest the store rejected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const completeModel = vi.fn(async () =>
      modelMessage({ headline: "Fixing tests", health: "grinding" }),
    );
    const persistDigest = vi.fn(async () => false);
    const harness = createHarness({ completeModel, persistDigest });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();

    completeModel.mockRejectedValue(new Error("model unavailable"));
    harness.observer.handleEvent(
      event({ stream: "lifecycle", data: { phase: "end", endedAt: 30_000 } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await flushObserver();
    const terminalBroadcasts = harness.broadcastToConnIds.mock.calls.filter(
      (call) =>
        call[0] === "session.observer" &&
        (call[1] as SessionObserverDigest | undefined)?.health === "done",
    );
    expect(terminalBroadcasts).toHaveLength(0);
    harness.observer.dispose();
  });

  it("suppresses assistant notes while a runtime-context block is still streaming", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const harness = createHarness();
    startAndAddToolNotes(harness.observer);
    harness.observer.handleEvent(
      event({
        stream: "assistant",
        data: { delta: "prose before\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n" },
      }),
    );
    harness.observer.handleEvent(
      event({ stream: "assistant", data: { delta: "private-context-body-must-not-leave" } }),
    );
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledOnce();
    const openPrompt = String(
      harness.completeModel.mock.calls[0]?.[0]?.context?.messages?.[0]?.content,
    );
    expect(openPrompt).not.toContain("private-context-body-must-not-leave");
    expect(openPrompt).not.toContain("Assistant:");

    harness.observer.handleEvent(
      event({
        stream: "assistant",
        data: { delta: "\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nvisible prose after" },
      }),
    );
    startAndAddToolNotes(harness.observer, { count: 4 });
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(harness.completeModel).toHaveBeenCalledTimes(2);
    const closedPrompt = String(
      harness.completeModel.mock.calls[1]?.[0]?.context?.messages?.[0]?.content,
    );
    expect(closedPrompt).not.toContain("private-context-body-must-not-leave");
    expect(closedPrompt).toContain("visible prose after");
    harness.observer.dispose();
  });

  it("invalidates the persist-time guard after disposal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const persistDigest = vi.fn(async () => true);
    const harness = createHarness({ persistDigest });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    const guard = persistDigest.mock.calls[0]?.[0]?.stillCurrent as (() => boolean) | undefined;
    expect(guard?.()).toBe(true);
    harness.observer.dispose();
    expect(guard?.()).toBe(false);
  });

  it("does not throttle the next digest after a rejected persist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const persistDigest = vi.fn(async () => false);
    const harness = createHarness({ persistDigest });
    startAndAddToolNotes(harness.observer);
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(persistDigest).toHaveBeenCalledOnce();

    persistDigest.mockResolvedValue(true);
    startAndAddToolNotes(harness.observer, { count: 4 });
    await vi.advanceTimersByTimeAsync(12_000);
    await flushObserver();
    expect(persistDigest).toHaveBeenCalledTimes(2);
    harness.observer.dispose();
  });
});

describe("session observer schema", () => {
  it("validates protocol digests", () => {
    expect(
      Value.Check(SessionObserverDigestSchema, {
        sessionKey: "agent:main:session-1",
        runId: "run-1",
        revision: 1,
        updatedAt: 1,
        headline: "Checking the implementation",
        health: "on-track",
        planProgress: { completed: 2, total: 4 },
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionObserverDigestSchema, {
        sessionKey: "agent:main:session-1",
        revision: 1,
        updatedAt: 1,
        headline: "x".repeat(121),
        health: "on-track",
      }),
    ).toBe(false);
  });

  it("rejects loose JSON and truncates accepted strings to hard caps", () => {
    expect(normalizeSessionObserverModelOutput("```json\n{}\n```")).toBeNull();
    const normalized = normalizeSessionObserverModelOutput(
      JSON.stringify({
        headline: "h".repeat(140),
        assessment: "a".repeat(400),
        health: "grinding",
      }),
    );
    expect(normalized?.headline).toHaveLength(120);
    expect(normalized?.assessment).toHaveLength(320);
  });
});

describe("session observer run bookkeeping", () => {
  it("bounds dormant runs and preserves revision continuity for evicted entries", async () => {
    const { rememberSessionObserverDormantRun } = await import("./session-observer-model.js");
    const runs = new Map();
    const floors = new Map();
    for (let index = 0; index < 300; index += 1) {
      rememberSessionObserverDormantRun(runs, floors, {
        sessionKey: `agent:main:session-${index}`,
        sessionId: `session-${index}`,
        runId: `run-${index}`,
        agentId: "main",
        utilityModelRef: "openai/gpt-test",
        startedAt: index,
        lastPersistedAt: undefined,
        revision: index + 1,
        digestCount: 1,
        consecutiveFailures: 0,
        planProgress: undefined,
        previousDigest: undefined,
      });
    }
    expect(runs.size).toBe(256);
    expect(runs.has("run-0")).toBe(false);
    expect(runs.has("run-299")).toBe(true);
    expect(floors.get("agent:main:session-0")?.revision).toBe(1);
  });

  it("bounds disabled-run bookkeeping", async () => {
    const { rememberSessionObserverDisabledRun } = await import("./session-observer-model.js");
    const runs = new Set<string>();
    for (let index = 0; index < 600; index += 1) {
      rememberSessionObserverDisabledRun(runs, `run-${index}`);
    }
    expect(runs.size).toBe(512);
    expect(runs.has("run-0")).toBe(false);
    expect(runs.has("run-599")).toBe(true);
  });
});
