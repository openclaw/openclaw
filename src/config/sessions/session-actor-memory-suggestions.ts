import { randomUUID } from "node:crypto";
import type { SessionActorMemoryCollaborationCommand } from "./session-actor-memory-collaboration-contract.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import type {
  SessionSuggestionListParams,
  StoredSessionSuggestion,
} from "./session-sharing-store.types.js";
import {
  MAX_PENDING_SESSION_SUGGESTIONS_PER_AUTHOR,
  MAX_PENDING_SESSION_SUGGESTIONS_PER_SESSION,
  MAX_RETAINED_RESOLVED_SESSION_SUGGESTIONS,
  SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS,
} from "./session-suggestion-policy.js";

const compareText = (left: string, right: string) =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));
const compareSuggestion = (left: StoredSessionSuggestion, right: StoredSessionSuggestion) =>
  left.createdAt - right.createdAt || compareText(left.id, right.id);

export function readSessionActorMemorySuggestions(
  context: SessionActorMemoryStorageContext,
  params: SessionSuggestionListParams = {},
) {
  const authorId = params.authorId?.trim();
  return [...context.state.collaboration.suggestions.values()]
    .map(({ suggestion }) => suggestion)
    .filter(
      (suggestion) =>
        (!authorId || suggestion.authorId === authorId) &&
        (!params.pendingOnly || suggestion.state === "pending"),
    )
    .toSorted(compareSuggestion);
}

function pruneResolved(context: SessionActorMemoryStorageContext) {
  const resolved = readSessionActorMemorySuggestions(context).filter(
    (row) => row.state !== "pending",
  );
  for (const row of resolved.slice(
    0,
    Math.max(0, resolved.length - MAX_RETAINED_RESOLVED_SESSION_SUGGESTIONS),
  )) {
    context.state.collaboration.suggestions.delete(row.id);
  }
}

export function mutateSessionActorMemorySuggestion(
  context: SessionActorMemoryStorageContext,
  command: Extract<
    SessionActorMemoryCollaborationCommand,
    { type: `session.collaboration.suggestion.${string}` }
  >,
) {
  const suggestions = context.state.collaboration.suggestions;
  if (command.type === "session.collaboration.suggestion.add") {
    const params = command.input.params;
    const authorId = params.authorId.trim();
    const authorLabel = params.authorLabel?.trim();
    if (!authorId || !params.text.trim()) {
      throw new Error("suggestion author and text are required");
    }
    pruneResolved(context);
    const pending = readSessionActorMemorySuggestions(context, { pendingOnly: true });
    if (pending.length >= MAX_PENDING_SESSION_SUGGESTIONS_PER_SESSION) {
      throw new Error("session pending suggestion limit reached");
    }
    if (
      pending.filter((row) => row.authorId === authorId).length >=
      MAX_PENDING_SESSION_SUGGESTIONS_PER_AUTHOR
    ) {
      throw new Error("author pending suggestion limit reached");
    }
    const id = params.id ?? randomUUID();
    // IDs share the agent's logical store, including other incognito sessions.
    for (const [, state] of context.entries()) {
      if (state.collaboration.suggestions.has(id)) {
        throw new Error("UNIQUE constraint failed: session_suggestions.id");
      }
    }
    const suggestion: StoredSessionSuggestion = {
      id,
      authorId,
      ...(authorLabel ? { authorLabel } : {}),
      text: params.text,
      createdAt: params.createdAt ?? Date.now(),
      state: "pending",
    };
    suggestions.set(id, { suggestion });
    return suggestion;
  }
  const params = command.input.params;
  const row = suggestions.get(params.id);
  if (!row || row.suggestion.state !== "pending") {
    return command.type === "session.collaboration.suggestion.release" ? false : null;
  }
  switch (command.type) {
    case "session.collaboration.suggestion.claim": {
      const { now = Date.now(), resolution } = command.input.params;
      if (row.dispatch && now - row.dispatch.startedAt < SESSION_SUGGESTION_DISPATCH_CLAIM_TTL_MS) {
        return { kind: "busy" as const };
      }
      if (row.dispatch && row.dispatch.resolution !== resolution) {
        return { kind: "mismatch" as const, resolution: row.dispatch.resolution };
      }
      const token = randomUUID();
      suggestions.set(params.id, {
        suggestion: row.suggestion,
        dispatch: { token, startedAt: now, resolution },
      });
      return { kind: "claimed" as const, suggestion: row.suggestion, token };
    }
    case "session.collaboration.suggestion.release":
      if (row.dispatch?.token !== command.input.params.token) {
        return false;
      }
      suggestions.set(params.id, { suggestion: row.suggestion });
      return true;
    case "session.collaboration.suggestion.finalize": {
      if (row.dispatch?.token !== command.input.params.token) {
        return null;
      }
      const suggestion = { ...row.suggestion, state: command.input.params.state };
      suggestions.set(params.id, { suggestion });
      pruneResolved(context);
      return suggestion;
    }
  }
}
