import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { createSessionEntryWithTranscript } from "../../config/sessions/session-accessor.entry-mutation.js";
import { listSessionEntriesReadOnly } from "../../config/sessions/session-accessor.entry.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.transcript.js";
import { captureSessionActorStorageOwner } from "../../config/sessions/session-actor-storage-binding.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { appendPreparedTranscriptEvent } from "../../config/sessions/session-transcript-event.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  invokeHandler,
  messageCutContext as createMessageCutContext,
  messageCutParams,
} from "./sessions-rewind.handler.test-support.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

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
  setRuntimeConfigSnapshot(cfg);
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
  for (const [eventId, parentId, role, content] of [
    ["user-1", null, "user", "Remember lighthouse."],
    ["assistant-1", "user-1", "assistant", "Lighthouse."],
    ["user-2", "assistant-1", "user", "What did I say?"],
    ["alternate-user", null, "user", "An alternate branch."],
  ] as const) {
    await appendTranscriptMessage(scope, { eventId, parentId, message: { role, content } });
  }
  await appendPreparedTranscriptEvent(
    scope,
    { type: "leaf", id: "active-leaf", parentId: "alternate-user", targetId: "user-2" },
    () => {},
  );
  await waitForSessionTranscriptIndexReconcile(toDatabaseOptions(resolveSqliteScope(scope)));
  return scope;
}

export const messageCutContext = () => createMessageCutContext(cfg);

export function mutationParams(method: MutationMethod, sessionKey: string) {
  return messageCutParams(
    method,
    sessionKey,
    method === "sessions.branches.switch" ? "alternate-user" : "user-2",
  );
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
  const completion = invokeHandler(method, undefined, {
    req: { type: "req", id: "message-cut-storage", method, params },
    params,
    respond,
    context: messageCutContext(),
    ...options,
  });
  // Observe rejection immediately while the test controls an earlier queued writer.
  const error = completion.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  return { respond, error };
}

export async function readMutationStorage(scope: SourceScope) {
  const memory = captureSessionActorStorageOwner(scope, { assertCurrent() {}, authorize() {} });
  const snapshots = memory?.owner?.listSessions(memory.authority) ?? [];
  const options = memory ? undefined : toDatabaseOptions(resolveSqliteScope(scope));
  const source = await readSessionEntryReadOnlyInWorker(scope);
  const history = await loadTranscriptEvents(scope);
  if (memory) {
    return {
      source,
      history,
      sessions: memory.owner?.listSessionEntries(memory.authority) ?? [],
      // Include retired windows so a rejected cut cannot leave orphaned private history.
      transcripts: await Promise.all(
        snapshots.flatMap(({ dependencySessionIds, target }) =>
          dependencySessionIds.map(async (sessionId) => ({
            sessionId,
            events: await loadTranscriptEvents({
              ...scope,
              sessionKey: target.sessionKey,
              sessionId,
            }),
          })),
        ),
      ),
    };
  }
  const stored = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const db = getSessionKysely(database.db);
      return {
        sessions: listSessionEntriesReadOnly({ agentId: scope.agentId }),
        // Include every transcript generation so a rejected copy cannot leave orphaned private rows.
        transcripts: executeSqliteQuerySync(
          database.db,
          db.selectFrom("transcript_events").selectAll().orderBy("seq"),
        ).rows,
      };
    },
    expectDefined(options, "durable storage scope"),
  );
  const data = expectDefined(stored.found ? stored.value : undefined, "mutation storage");
  return { source, history, ...data };
}
