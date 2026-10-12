import { expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "../agents/subagents/registry/subagent-lifecycle-events.js";
import { SubagentLifecycleController } from "../agents/subagents/registry/subagent-registry-lifecycle.js";
import { persistRegistryFixture } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { onceMessage, writeSessionStore } from "./test-helpers.server.js";

export function registerRecoveredSubagentSessionEventTest({
  createSessionStoreFile,
  withOperatorSessionSubscriber,
  expectNoMessageWithin,
  expectRecordFields,
}: {
  createSessionStoreFile: () => Promise<string>;
  withOperatorSessionSubscriber: <T>(run: (ws: WebSocket) => Promise<T>) => Promise<T>;
  expectNoMessageWithin: (params: {
    action?: () => Promise<void> | void;
    watch: (timeoutMs: number) => Promise<unknown>;
    timeoutMs?: number;
  }) => Promise<void>;
  expectRecordFields: (value: unknown, expected: Record<string, unknown>) => void;
}) {
  test("broadcasts a recovered subagent terminal session to a subscribed gateway exactly once", async () => {
    const storePath = await createSessionStoreFile();
    const entry = createSubagentRunRecord({
      runId: "run-recovered-subscriber",
      childSessionKey: "agent:main:subagent:recovered-subscriber",
      requesterSessionKey: "agent:main:parent",
      requesterDisplayKey: "parent",
      task: "finish recovered child work",
      cleanup: "keep",
      createdAt: 1_000,
      execution: { status: "running", startedAt: 2_000 },
    });
    await writeSessionStore({
      entries: {
        [entry.childSessionKey]: {
          sessionId: "sess-recovered-subscriber",
          spawnedBy: entry.requesterSessionKey,
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    const runs = new Map([[entry.runId, entry]]);
    persistRegistryFixture(runs, [entry.runId]);
    const emitSubagentProgressEndedForRun = vi.fn(async () => {});
    const controller = new SubagentLifecycleController({
      runs,
      resumedRuns: new Set(),
      subagentAnnounceTimeoutMs: 1_000,
      getRuntimeConfig: () => ({}),
      clearPendingLifecycleError: vi.fn(),
      countPendingDescendantRuns: async () => 0,
      getLatestRunForChildSession: () => null,
      suppressAnnounceForSteerRestart: () => false,
      shouldEmitEndedHookForRun: () => false,
      emitSubagentEndedHookForRun: vi.fn(async () => {}),
      emitSubagentProgressEndedForRun,
      notifyContextEngineSubagentEnded: vi.fn(async () => {}),
      retireSupersededRun: vi.fn(async () => {}),
      resumeSubagentRun: vi.fn(),
      callGateway: async <T = Record<string, unknown>>() => ({}) as T,
      captureSubagentCompletionReply: vi.fn(async () => undefined),
      runSubagentAnnounceFlow: vi.fn(async () => "retryable" as const),
      maybeWakeRequesterAfterAllChildrenSettled: vi.fn(async () => false),
      warn: vi.fn(),
    });
    const completion = {
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error" as const, error: "restart interrupted run" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: false,
      recoverInterrupted: true,
    } satisfies Parameters<typeof controller.completeSubagentRun>[0];

    await withOperatorSessionSubscriber(async (ws) => {
      const waitForRecoveredTerminal = (timeoutMs?: number) =>
        onceMessage(
          ws,
          (message) =>
            message.type === "event" &&
            message.event === "sessions.changed" &&
            (message.payload as { sessionKey?: string; reason?: string } | undefined)
              ?.sessionKey === entry.childSessionKey &&
            (message.payload as { reason?: string } | undefined)?.reason === "subagent-status",
          timeoutMs,
        );
      const changedEvent = waitForRecoveredTerminal();

      await controller.completeSubagentRun(completion);

      const event = await changedEvent;
      expectRecordFields(event.payload, {
        sessionKey: entry.childSessionKey,
        reason: "subagent-status",
        status: "interrupted",
        endedAt: completion.endedAt,
        spawnedBy: entry.requesterSessionKey,
      });
      const terminalEntry = expect.objectContaining({
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
        execution: expect.objectContaining({
          status: "terminal",
          endedAt: completion.endedAt,
          outcome: expect.objectContaining(completion.outcome),
        }),
      });
      expect(emitSubagentProgressEndedForRun).toHaveBeenCalledExactlyOnceWith(terminalEntry);

      // A resumed callback must not publish a second terminal event to an
      // already-subscribed Control UI client for the same child generation.
      await expectNoMessageWithin({
        action: () => controller.completeSubagentRun(completion),
        watch: waitForRecoveredTerminal,
      });
      expect(emitSubagentProgressEndedForRun).toHaveBeenCalledExactlyOnceWith(terminalEntry);
    });
  });
}
