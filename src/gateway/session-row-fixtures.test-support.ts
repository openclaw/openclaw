import { normalizeUsage, type UsageLike } from "../agents/usage.js";
import { prepareSessionUsageUpdate } from "../auto-reply/reply/session-usage.js";
import {
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import { projectSessionEntryUsageUpdate } from "../config/sessions/session-entry-usage.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { clearStoredSessionRowTranscriptForTest } from "./session-row-backfill.test-support.js";
import { writeSessionStore } from "./test-helpers.server.js";

type CompletedReply = Record<string, unknown> & {
  role: "assistant";
  provider: string;
  model: string;
  usage: UsageLike;
};

/** Seed the same transcript and accounting commits that finish a reply. */
export async function seedCompletedSessionTranscript<T extends CompletedReply>(params: {
  storePath: string;
  sessionKey: string;
  sessionId: string;
  entries: Parameters<typeof writeSessionStore>[0]["entries"];
  message: T;
  trailingMessages?: readonly Record<string, unknown>[];
}): Promise<T> {
  const scope = {
    agentId: resolveAgentIdFromSessionKey(params.sessionKey),
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    storePath: params.storePath,
  };
  await writeSessionStore({
    agentId: scope.agentId,
    storePath: params.storePath,
    entries: params.entries,
  });
  await persistSessionTranscriptTurn(scope, {
    messages: [params.message, ...(params.trailingMessages ?? [])].map((message) => ({ message })),
    updateMode: "none",
  });
  const usage = normalizeUsage(params.message.usage);
  const prepared = prepareSessionUsageUpdate({
    usage,
    lastCallUsage: usage,
    providerUsed: params.message.provider,
    modelUsed: params.message.model,
    preserveRuntimeModel: true,
  });
  if (prepared) {
    await patchSessionEntryCore(scope, (entry) =>
      projectSessionEntryUsageUpdate(entry, {
        ...prepared.update,
        estimatedCostUsd: prepared.estimateCost(entry),
      }),
    );
  }
  return params.message;
}

/**
 * Legacy rows retain missing titles and need their first durable preview backfill. The last
 * `durable` rows keep their facts, as when another Gateway projection already backfilled them.
 */
export async function seedSessionListBackfillFixture(
  storePath: string,
  count: number,
  durable: number,
) {
  const now = Date.now();
  const rows = Array.from({ length: count }, (_, index) => ({
    sessionId: `sess-list-yield-${index}`,
    sessionKey: `agent:main:bulk-${index}`,
    updatedAt: now - index,
  }));
  await writeSessionStore({
    storePath,
    entries: Object.fromEntries(rows.map(({ sessionKey, ...entry }) => [sessionKey, entry])),
  });
  for (const [index, row] of rows.entries()) {
    await persistSessionTranscriptTurn(
      { ...row, agentId: "main", storePath },
      {
        messages: [
          { message: { role: "user", content: `title ${index}` } },
          { message: { role: "assistant", content: `last ${index}` } },
        ],
        updateMode: "none",
      },
    );
    if (index < count - durable) {
      clearStoredSessionRowTranscriptForTest({ ...row, agentId: "main", storePath });
    }
  }
  return rows.map((row) => row.sessionKey);
}
