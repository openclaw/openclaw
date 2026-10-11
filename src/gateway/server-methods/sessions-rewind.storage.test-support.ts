import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { createSessionEntryWithTranscript } from "../../config/sessions/session-accessor.entry-mutation.js";
import {
  listSessionEntriesCore,
  loadSessionEntry,
} from "../../config/sessions/session-accessor.entry.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.transcript.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { sessionRewindHandlers } from "./sessions-rewind.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

export const cfg = { agents: { entries: { main: {} } } };
export const mutationMethods = [
  "sessions.fork",
  "sessions.rewind",
  "sessions.branches.switch",
] as const;
type MutationMethod = (typeof mutationMethods)[number];
export type SourceScope = Awaited<ReturnType<typeof seedMessageCutSource>>;

export function useMessageCutStorageFixture() {
  beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
  });
}

export async function seedMessageCutSource(
  incognito = false,
  identity?: { sessionKey: string; sessionId: string },
) {
  const sessionKey = `agent:main:dashboard:${incognito ? "incognito-" : ""}source`;
  const scope = { agentId: "main", sessionKey, sessionId: "message-fork-source", ...identity };
  const created = await createSessionEntryWithTranscript(scope, () => ({
    ok: true,
    entry: {
      sessionId: scope.sessionId,
      lifecycleRevision: "message-fork-source-lifecycle",
      updatedAt: Date.now(),
      visibility: "read-only",
      createdActor: { type: "human", source: "profile", id: "owner" },
      ...(incognito ? { incognito: true as const } : {}),
    },
  }));
  expect(created.ok).toBe(true);
  for (const message of [
    { eventId: "user-1", parentId: null, role: "user", content: "Remember lighthouse." },
    { eventId: "assistant-1", parentId: "user-1", role: "assistant", content: "Lighthouse." },
    { eventId: "user-2", parentId: "assistant-1", role: "user", content: "What did I say?" },
    { eventId: "alternate-user", parentId: null, role: "user", content: "An alternate branch." },
  ]) {
    await appendTranscriptMessage(scope, {
      eventId: message.eventId,
      parentId: message.parentId,
      message: { role: message.role, content: message.content },
    });
  }
  await appendTranscriptEvent(scope, {
    type: "leaf",
    id: "active-leaf",
    parentId: "alternate-user",
    targetId: "user-2",
  });
  return scope;
}

export function messageCutContext(): GatewayRequestContext {
  return {
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set(),
  } as unknown as GatewayRequestContext;
}

export function mutationParams(method: MutationMethod, sessionKey: string) {
  return {
    sessionKey,
    ...(method === "sessions.branches.switch"
      ? { leafEntryId: "alternate-user" }
      : { entryId: "user-2" }),
  };
}

export function invokeMessageCut(
  method: MutationMethod,
  scope: SourceScope,
  options: Partial<
    Pick<
      GatewayRequestHandlerOptions,
      "client" | "context" | "sessionMutationCommitGuard" | "sessionMutationAuthorization"
    >
  > = {},
) {
  const params = mutationParams(method, scope.sessionKey);
  const respond = vi.fn<RespondFn>();
  const completion = (async () => {
    await expectDefined(
      sessionRewindHandlers[method],
      `${method} handler`,
    )({
      req: { type: "req", id: "message-cut-storage", method, params },
      params,
      respond,
      context: messageCutContext(),
      client: null,
      isWebchatConnect: () => false,
      ...options,
    });
  })();
  // Observe rejection immediately while the test controls an earlier queued writer.
  const error = completion.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  return { respond, error };
}

export async function readMutationStorage(scope: SourceScope) {
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
  const db = getSessionKysely(database.db);
  return {
    source: loadSessionEntry(scope),
    history: await loadTranscriptEvents(scope),
    sessions: listSessionEntriesCore({ agentId: scope.agentId }),
    // Include every transcript generation so a rejected copy cannot leave orphaned private rows.
    transcripts: executeSqliteQuerySync(
      database.db,
      db.selectFrom("transcript_events").selectAll().orderBy("seq"),
    ).rows,
  };
}
