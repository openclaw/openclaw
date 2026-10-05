import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionActivityNoteState } from "../agents/session-activity-notes.js";
import { createSessionObserverCompletion } from "./session-observer-completion.js";
import type { SessionObserverDeps, SessionObserverState } from "./session-observer-model.js";
import {
  createHarness,
  flushObserver,
  modelMessage,
  resetSessionObserverEventSequence,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetSessionObserverEventSequence();
});

describe("session observer completion", () => {
  it("reports a redacted, collapsed, bounded prefix of the last of two rejected replies", async () => {
    const password = `synthetic-${"x".repeat(200)}-credential`;
    const result = {
      text: "first rejected output",
      provider: "openai",
      model: "gpt-test",
      owner: { kind: "harness" as const, id: "openclaw" },
    };
    const completeModel = vi
      .fn<NonNullable<SessionObserverDeps["completeModel"]>>()
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce({
        ...result,
        text: ` \n last\t rejected\noutput password=${password}\n${"x".repeat(180)} `,
      });
    const request = createSessionObserverCompletion({
      getConfig: () => ({}),
      prepareModel: vi.fn(async () => ({
        config: {},
        provider: "openai",
        model: "gpt-test",
        authProfileId: undefined,
        outputTextPolicy: "strict-visible" as const,
        agentId: "main",
        agentDir: "/tmp/agent",
      })),
      completeModel,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
      isCurrent: () => true,
    });
    const state: SessionObserverState = {
      ...createSessionActivityNoteState(),
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      agentId: "main",
      utilityModelRef: "openai/gpt-test",
      startedAt: 0,
      lastActivityAt: 0,
      lastRunAt: 0,
      revision: 0,
      digestCount: 0,
      consecutiveFailures: 0,
      lastDigestNoteSequence: 0,
      inFlight: false,
      finalPending: false,
    };
    const prefix = "last rejected output password=synthe…tial ";

    await expect(request(state, [])).rejects.toThrow(
      new Error(
        `session observer returned invalid JSON twice; last rejected output: ${prefix}${"x".repeat(160 - prefix.length)}`,
      ),
    );
    expect(completeModel).toHaveBeenCalledTimes(2);
  });

  it("publishes a digest from a utility model that answers after 15s", async () => {
    vi.setSystemTime(0);
    // CLI-backed utility models (for example claude-cli Haiku) take 9-16s per call.
    const completeModel = vi.fn(
      (params: { timeoutMs?: number; abortSignal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          params.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
          setTimeout(
            () =>
              resolve(
                modelMessage({
                  headline: "Reviewing the implementation",
                  assessment: "The work is progressing steadily.",
                  health: "on-track",
                }),
              ),
            15_000,
          );
        }),
    );
    const harness = createHarness({ completeModel });
    startAndAddToolNotes(harness.observer);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(completeModel).toHaveBeenCalledOnce();
    expect(completeModel.mock.calls[0]?.[0].timeoutMs).toBe(30_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await flushObserver();

    expect(completeModel.mock.calls[0]?.[0].abortSignal?.aborted).toBe(false);
    expect(harness.broadcastToConnIds).toHaveBeenCalledWith(
      "session.observer",
      expect.objectContaining({ headline: "Reviewing the implementation", health: "on-track" }),
      expect.any(Set),
      expect.anything(),
    );
    harness.observer.dispose();
  });
});
