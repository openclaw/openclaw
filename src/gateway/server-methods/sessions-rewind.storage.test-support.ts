import { afterEach, beforeEach, expect, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { createSessionEntryWithTranscript } from "../../config/sessions/session-accessor.entry-mutation.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.transcript.js";
import { appendPreparedTranscriptEvent } from "../../config/sessions/session-transcript-event.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
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

function mutationParams(method: MutationMethod, sessionKey: string) {
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
