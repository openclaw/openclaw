import { randomUUID } from "node:crypto";
import {
  assertModelSelectionUnlocked,
  MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE,
} from "../../sessions/model-overrides.js";
import { forkCliSessionBindings } from "./cli-session-binding.js";
import { formatSqliteSessionFileMarker } from "./legacy-sqlite-marker.js";
import {
  buildForkedChildTranscriptEvents,
  estimateParentForkPromptTokens,
  planParentForkDecision,
  resolveParentForkSourceTranscript,
} from "./session-accessor.sqlite-parent-fork.js";
import type { ForkSessionEntryFromParentTargetResult } from "./session-accessor.types.js";
import { installSessionActorMemoryEntry } from "./session-actor-memory-entry-install.js";
import { createSessionActorMemoryEvents } from "./session-actor-memory-events.js";
import type {
  SessionActorMemoryForkCommand,
  SessionActorMemoryForkQuery,
  SessionActorMemoryForkWrites,
} from "./session-actor-memory-fork-contract.js";
import {
  createSessionActorMemoryState,
  resolveSessionActorMemoryWindow,
} from "./session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import { planSessionMessageCut } from "./session-message-cut-plan.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { mergeSessionEntry, type InternalSessionEntry as SessionEntry } from "./types.js";

export function readSessionActorMemoryForkQuery(
  context: SessionActorMemoryStorageContext,
  query: SessionActorMemoryForkQuery,
) {
  const state = query.input.sessionKey
    ? context.get(normalizeStoreSessionKey(query.input.sessionKey))
    : context.state;
  const window = state && resolveSessionActorMemoryWindow(state, query.input.sessionId);
  return window
    ? resolveParentForkSourceTranscript(
        window.events.map(({ event }) => event),
        query.input.forkFrom,
      )
    : null;
}

function commitParentFork(
  context: SessionActorMemoryStorageContext,
  input: SessionActorMemoryForkWrites["session.parentFork.commit"]["input"],
): ForkSessionEntryFromParentTargetResult {
  const parentKey = normalizeStoreSessionKey(input.params.parentTarget.canonicalKey);
  const targetKey = normalizeStoreSessionKey(input.params.sessionTarget.canonicalKey);
  const parent = context.get(parentKey);
  const parentEntry = parent?.hot.entry;
  if (!parent || !parentEntry?.sessionId) {
    return { status: "missing-parent" };
  }
  const base = context.get(targetKey)?.hot.entry ?? input.params.fallbackEntry;
  if (!base) {
    return { status: "missing-entry" };
  }
  if (
    input.callbacks?.skipForkWhen?.(structuredClone(base)) ??
    (input.patch?.skipExisting && base.sessionId.trim())
  ) {
    const skipped = input.callbacks?.skipPatch?.(structuredClone(base)) ?? input.patch?.skipped;
    const sessionEntry = skipped
      ? installSessionActorMemoryEntry(
          context.edit(targetKey),
          preserveSqliteSameKeySessionRolloverLineage({
            next: mergeSessionEntry(base, skipped),
            previous: base,
            sessionKey: targetKey,
          }),
        )
      : base;
    return { status: "skipped", reason: "existing-entry", parentEntry, sessionEntry };
  }
  assertModelSelectionUnlocked(parentEntry, MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
  const source = resolveParentForkSourceTranscript(parent.events.map(({ event }) => event));
  const decision = planParentForkDecision(parentEntry, estimateParentForkPromptTokens(source));
  if (decision.status === "skip") {
    const patch = input.callbacks?.decisionSkipPatch?.({
      decision,
      entry: structuredClone(base),
      parentEntry: structuredClone(parentEntry),
    });
    const sessionEntry = patch
      ? installSessionActorMemoryEntry(
          context.edit(targetKey),
          preserveSqliteSameKeySessionRolloverLineage({
            next: mergeSessionEntry(base, patch),
            previous: base,
            sessionKey: targetKey,
          }),
        )
      : base;
    return {
      status: "skipped",
      reason: "decision-skip",
      parentEntry,
      sessionEntry,
      decision,
    };
  }
  if (!source) {
    return { status: "failed" };
  }
  const sessionId = randomUUID();
  const patch =
    input.callbacks?.patch?.({
      decision,
      entry: structuredClone(base),
      parentEntry: structuredClone(parentEntry),
      fork: { sessionId, sessionFile: targetKey },
    }) ?? input.patch?.forked;
  const next: SessionEntry = {
    ...mergeSessionEntry(base, {
      ...patch,
      forkSource: { sessionKey: parentKey, sessionId: parentEntry.sessionId },
      forkedFromParent: true,
      sessionId,
      totalTokens: undefined,
      totalTokensFresh: false,
      totalTokensVersion: undefined,
      cliSessionBindings: forkCliSessionBindings(
        parentEntry,
        input.supportsCliFork ?? (() => false),
      ),
      cliSessionIds: undefined,
      claudeCliSessionId: undefined,
    }),
    lifecycleRunId: undefined,
    lastRunId: undefined,
  };
  const target = context.edit(targetKey);
  const sessionEntry = installSessionActorMemoryEntry(target, next);
  const events = createSessionActorMemoryEvents({ ...context, state: target });
  const forkedEvents = buildForkedChildTranscriptEvents({
    parentSessionFile: formatSqliteSessionFileMarker({
      agentId: context.agentId,
      sessionId: parentEntry.sessionId,
      storePath: context.path,
    }),
    source,
    targetSessionId: sessionId,
  });
  events.replaceRows(
    forkedEvents.map((event, rawSeq) => {
      const eventJson = JSON.stringify(event);
      return { rawSeq, eventJson, event: JSON.parse(eventJson) };
    }),
  );
  return {
    status: "forked",
    decision,
    fork: { sessionFile: targetKey, sessionId },
    parentEntry,
    sessionEntry,
  };
}

export function executeSessionActorMemoryForkCommand(
  context: SessionActorMemoryStorageContext,
  command: SessionActorMemoryForkCommand,
) {
  switch (command.type) {
    case "session.parentFork.commit":
      return commitParentFork(context, command.input);
    case "session.parentFork.transcript": {
      const target = context.edit(context.state.hot.target.sessionKey);
      // Transcript-only forks precede child entry creation. Keep their window with the actor
      // so creation can adopt it without inventing a live logical entry.
      const current = target.hot.entry?.sessionId === command.input.sessionId;
      const window = current ? target : createSessionActorMemoryState(target.hot.target);
      const previous = target.historicalWindows.get(command.input.sessionId);
      if (!current) {
        if (previous) {
          Object.assign(window, structuredClone(previous));
        } else {
          installSessionActorMemoryEntry(window, {
            sessionId: command.input.sessionId,
            updatedAt: Date.now(),
          });
        }
      }
      const events = createSessionActorMemoryEvents({ ...context, state: window });
      for (const event of command.input.events) {
        events.writeEvent(event);
      }
      if (!current) {
        target.historicalWindows.set(command.input.sessionId, {
          hot: window.hot,
          usageRollup: window.usageRollup,
          sourceCreatedAt: window.sourceCreatedAt,
          conversationLinks: window.conversationLinks,
          primaryConversationRef: window.primaryConversationRef,
          workerTranscriptCommits: window.workerTranscriptCommits,
          events: window.events,
          pendingInputs: window.pendingInputs,
          completions: window.completions,
          goalReceipts: window.goalReceipts,
        });
      }
      return {
        status: "created" as const,
        transcript: {
          sessionId: command.input.sessionId,
          sessionFile: target.hot.target.sessionKey,
        },
      };
    }
    case "session.messageCut": {
      const { intent, sourceRepositoryWorkspaceId } = command.input;
      const source = context.get(normalizeStoreSessionKey(intent.sourceKey));
      const plan = planSessionMessageCut(
        source?.hot.entry,
        source?.events.map(({ event }) => event) ?? [],
        {
          ...intent,
          expectedState:
            intent.expectedState ??
            (source?.hot.entry && {
              sessionId: source.hot.entry.sessionId,
              lifecycleRevision: source.hot.entry.lifecycleRevision,
            }),
        },
        sourceRepositoryWorkspaceId,
      );
      if (plan.status !== "prepared") {
        return plan;
      }
      const targetKey = normalizeStoreSessionKey(intent.targetKey);
      const target = context.edit(targetKey);
      const entry = installSessionActorMemoryEntry(target, plan.result.entry);
      const events = createSessionActorMemoryEvents({ ...context, state: target });
      events.replaceRows(
        plan.events.map((event, rawSeq) => {
          const eventJson = JSON.stringify(event);
          return { rawSeq, eventJson, event: JSON.parse(eventJson) };
        }),
      );
      return { ...plan.result, entry };
    }
  }
  throw new Error("Unknown memory fork command");
}
