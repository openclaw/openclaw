import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionActivityNoteState } from "../agents/session-activity-notes.js";
import { createSessionObserverCompletion } from "./session-observer-completion.js";
import type { SessionObserverDeps, SessionObserverState } from "./session-observer-model.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
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
});
