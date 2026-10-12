import { upsertSessionEntryCore } from "../config/sessions/session-accessor.entry.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import { prewarmSessionHistoryWorker } from "../config/sessions/session-transcript-worker-runtime.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { SessionActivitySummaryService } from "./session-activity-summaries.js";

export const target = { key: "agent:main:recap", agentId: "main" };
export const scope = {
  sessionKey: target.key,
  agentId: target.agentId,
  sessionId: "recap-session",
};
export async function messages(count: number, start = 0) {
  await persistSessionTranscriptTurn(scope, {
    expectedSessionId: scope.sessionId,
    messages: Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      return {
        eventId: `message-${index}`,
        parentId: index ? `message-${index - 1}` : null,
        message: {
          role: index % 2 ? "assistant" : "user",
          content: `Outcome ${index}`,
          timestamp: Date.now(),
        },
      };
    }),
    touchSessionEntry: false,
  });
}

export function terminal(service: SessionActivitySummaryService) {
  service.handleEvent({
    ...target,
    sessionKey: target.key,
    sessionId: scope.sessionId,
    runId: "run",
    seq: 1,
    ts: Date.now(),
    stream: "lifecycle",
    data: { phase: "end" },
  });
}

export const preparedActivityRecapModel = {
  config: {},
  authProfileId: undefined,
  provider: "test",
  model: "utility",
  agentId: "main",
  agentDir: "/tmp/unused",
  outputTextPolicy: "strict-visible" as const,
};
export const activityRecapResult = (text: string) => ({
  text,
  provider: "test",
  model: "utility",
  owner: { kind: "harness" as const, id: "test" },
});

export async function createActivityRecapSessionFixture() {
  const state = await createOpenClawTestState({ scenario: "minimal" });
  try {
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      lifecycleRevision: "lifecycle-1",
      updatedAt: 1,
    });
    // Cleanup closes each test's database handle even when the worker survives.
    await prewarmSessionHistoryWorker({ agentId: scope.agentId, env: state.env });
    return state;
  } catch (error) {
    await state.cleanup();
    throw error;
  }
}
