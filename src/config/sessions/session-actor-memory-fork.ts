import { randomUUID } from "node:crypto";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
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
import { resolveSessionActorMemoryWindow } from "./session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import { preserveSqliteSameKeySessionRolloverLineage } from "./session-entry-lineage.js";
import { planSessionMessageCut } from "./session-message-cut-plan.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { mergeSessionEntry } from "./types.js";

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
  if (input.patch?.skipExisting && base.sessionId.trim()) {
    const sessionEntry = input.patch.skipped
      ? installSessionActorMemoryEntry(
          context.edit(targetKey),
          preserveSqliteSameKeySessionRolloverLineage({
            next: mergeSessionEntry(base, input.patch.skipped),
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
    return {
      status: "skipped",
      reason: "decision-skip",
      parentEntry,
      sessionEntry: base,
      decision,
    };
  }
  if (!source) {
    return { status: "failed" };
  }
  const providers = new Set(input.cliForkProviders?.map(normalizeProviderId));
  const sessionId = randomUUID();
  const next = mergeSessionEntry(base, {
    ...input.patch?.forked,
    forkSource: { sessionKey: parentKey, sessionId: parentEntry.sessionId },
    forkedFromParent: true,
    lifecycleRunId: undefined,
    lastRunId: undefined,
    sessionId,
    totalTokens: undefined,
    totalTokensFresh: false,
    totalTokensVersion: undefined,
    cliSessionBindings: forkCliSessionBindings(parentEntry, (provider) =>
      providers.has(normalizeProviderId(provider)),
    ),
    cliSessionIds: undefined,
    claudeCliSessionId: undefined,
  });
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
}
