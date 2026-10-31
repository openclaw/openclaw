import { vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.entry.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.transcript-turn.js";
import { prewarmSessionHistoryWorker } from "../config/sessions/session-transcript-worker-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { sessionActivitySummaryHandlers } from "./server-methods/session-activity-summary.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import type { SessionActivitySummaryService } from "./session-activity-summaries.js";

export const target = { key: "agent:main:recap", agentId: "main" };
export const scope = {
  sessionKey: target.key,
  agentId: target.agentId,
  sessionId: "recap-session",
};

export async function seedRecapConversation(
  session: typeof scope,
  content: string,
  entry: Partial<SessionEntry> = {},
  eventId = `event-${session.sessionKey}`,
) {
  await upsertSessionEntryCore(session, { sessionId: session.sessionId, updatedAt: 1, ...entry });
  await persistSessionTranscriptTurn(session, {
    messages: [{ eventId, message: { role: "user", content } }],
    touchSessionEntry: false,
  });
}

export function recapRpc(
  method: "sessions.describe" | "sessions.activitySummary.ensure",
  context: ReturnType<typeof createDirectChatContext>,
  id = "recap",
) {
  const respond = vi.fn();
  const handler =
    method === "sessions.describe"
      ? sessionByKeyReadHandlers[method]!
      : sessionActivitySummaryHandlers[method]!;
  return {
    respond,
    invoke: (params: Record<string, unknown>) =>
      handler({
        req: { type: "req", id, method, params },
        params,
        context,
        client: null,
        respond,
        isWebchatConnect: () => false,
      }),
  };
}
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
  thinkLevel: "off" as const,
};
export const activityRecapResult = (text: string) => ({
  text,
  provider: "test",
  model: "utility",
  owner: { kind: "harness" as const, id: "test" },
});

export async function createActivityRecapSessionFixture(cfg: OpenClawConfig = {}) {
  const state = await createOpenClawTestState({ scenario: "minimal" });
  try {
    setRuntimeConfigSnapshot(cfg);
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
