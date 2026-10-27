import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionLifecycleRevisionExpectation,
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import type { SqliteSessionTurnOptions } from "./session-turn.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Capture ordinary transcript admission state; execution authority remains live. */
export function buildSessionTranscriptTurnExpectedState(
  entry: SessionEntry,
): SessionTranscriptTurnExpectedState {
  return {
    abortedLastRun: entry.abortedLastRun,
    status: entry.status,
  };
}

export function sessionMatchesExpectedTranscriptTurn<T extends { entry: SessionEntry }>(
  selected: T | undefined,
  expected: {
    expectedLifecycleRevision?: SessionLifecycleRevisionExpectation;
    expectedWriterRunId?: SessionTranscriptTurnExpectedState["expectedWriterRunId"];
    expectedOwner?: Pick<SessionEntry, "lifecycleRevision" | "activeWriterRunId">;
    expectedSessionState?: SessionTranscriptTurnExpectedState;
    expectedSessionId: string;
  },
): selected is T {
  const expectedState = expected.expectedSessionState;
  return Boolean(
    selected &&
    selected.entry.sessionId === expected.expectedSessionId &&
    (expected.expectedLifecycleRevision === undefined ||
      selected.entry.lifecycleRevision === (expected.expectedLifecycleRevision ?? undefined)) &&
    (expected.expectedWriterRunId === undefined ||
      selected.entry.activeWriterRunId === expected.expectedWriterRunId) &&
    (expected.expectedOwner === undefined ||
      (selected.entry.lifecycleRevision === expected.expectedOwner.lifecycleRevision &&
        selected.entry.activeWriterRunId === expected.expectedOwner.activeWriterRunId)) &&
    (expectedState === undefined ||
      (selected.entry.abortedLastRun === expectedState.abortedLastRun &&
        (expectedState.goal === undefined ||
          isDeepStrictEqual(selected.entry.goal, expectedState.goal)) &&
        (expectedState.pendingFinalDelivery === undefined ||
          isDeepStrictEqual(
            selected.entry.pendingFinalDelivery,
            expectedState.pendingFinalDelivery ?? undefined,
          )) &&
        selected.entry.status === expectedState.status)),
  );
}

export function buildExpectedTranscriptTurnSessionPatch(params: {
  appendedMessages: readonly { appended: boolean; message?: unknown }[];
  currentEntry: SessionEntry;
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
  touchSessionEntry?: boolean;
}): Partial<SessionEntry> {
  let lastSubmittedModel: SessionEntry["lastSubmittedModel"];
  for (const append of params.appendedMessages) {
    const message = append.appended ? asOptionalRecord(append.message) : undefined;
    if (
      message?.role !== "user" ||
      message.display === false ||
      message.excludeFromContext === true ||
      (message.provenance && asOptionalRecord(message.provenance)?.kind !== "external_user")
    ) {
      continue;
    }
    const metadata = asOptionalRecord(message["__openclaw"]);
    if (metadata?.lateMedia === true || metadata?.beforeAgentRunBlocked !== undefined) {
      continue;
    }
    const selection = asOptionalRecord(metadata?.modelSelection);
    if (
      typeof selection?.provider === "string" &&
      selection.provider &&
      typeof selection.model === "string" &&
      selection.model
    ) {
      lastSubmittedModel = { provider: selection.provider, model: selection.model };
    }
  }
  const hasAppendedMessage = params.appendedMessages.some((message) => message.appended);
  const acceptedMessage =
    hasAppendedMessage ||
    (params.expectedSessionState !== undefined &&
      params.appendedMessages.some((message) => !message.appended));
  const touchUpdatedAt = params.touchSessionEntry === true && hasAppendedMessage ? Date.now() : 0;
  return {
    ...(acceptedMessage ? params.sessionLifecyclePatch : undefined),
    ...(lastSubmittedModel &&
    (lastSubmittedModel.provider !== params.currentEntry.lastSubmittedModel?.provider ||
      lastSubmittedModel.model !== params.currentEntry.lastSubmittedModel?.model)
      ? { lastSubmittedModel }
      : {}),
    ...(touchUpdatedAt > 0
      ? {
          updatedAt: Math.max(
            params.currentEntry.updatedAt ?? 0,
            params.sessionLifecyclePatch?.updatedAt ?? 0,
            touchUpdatedAt,
          ),
        }
      : {}),
  };
}

/** Prepare the shared entry-selection policy without opening a database. */
export function prepareSessionTranscriptTurnEntry(options: SqliteSessionTurnOptions) {
  const initialEntry = options.initialSessionEntry
    ? structuredClone(options.initialSessionEntry)
    : undefined;
  if (
    initialEntry &&
    (initialEntry.sessionId !== options.expectedSessionId ||
      options.expectedLifecycleRevision !== undefined ||
      options.expectedWriterRunId !== undefined ||
      options.expectedSessionState !== undefined)
  ) {
    throw new Error(
      "Session initialization requires its new identity and no existing writer state.",
    );
  }
  const resolveExpectedEntry = (selected: { entry: SessionEntry } | undefined) => {
    if (
      options.selectedSessionId !== undefined &&
      ((selected?.entry.sessionId ?? null) !== options.selectedSessionId ||
        selected?.entry.lifecycleRevision !== (options.selectedLifecycleRevision ?? undefined))
    ) {
      return undefined;
    }
    // A prepared creation cannot adopt a row that appeared while admission was awaiting work.
    if (initialEntry) {
      return selected ? undefined : initialEntry;
    }
    return sessionMatchesExpectedTranscriptTurn(selected, options) ? selected.entry : undefined;
  };
  return { initialEntry, resolveExpectedEntry };
}
