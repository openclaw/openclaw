import { normalizeUsage, type UsageLike } from "../agents/usage.js";
import { persistSessionUsageUpdate } from "../auto-reply/reply/session-usage.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
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
  await persistSessionUsageUpdate({
    ...scope,
    expectedSession: {
      sessionId: params.sessionId,
      lifecycleRevision: loadSessionEntry(scope)?.lifecycleRevision,
    },
    usage,
    lastCallUsage: usage,
    providerUsed: params.message.provider,
    modelUsed: params.message.model,
    preserveRuntimeModel: true,
  });
  return params.message;
}

/** Legacy rows retain missing titles until Doctor repairs them; previews remain transient. */
export async function seedSessionListBackfillFixture(storePath: string, count: number) {
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
  }
  return rows.map((row) => row.sessionKey);
}
