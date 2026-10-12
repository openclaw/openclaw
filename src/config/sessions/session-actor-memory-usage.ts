import {
  classifySessionEntry,
  collectCronGeneratedSessionKeys,
} from "../../../packages/memory-host-sdk/src/host/session-transcript-corpus-policy.js";
import type { SessionTranscriptCorpusEntry } from "../../../packages/memory-host-sdk/src/host/session-transcript-corpus.types.js";
import {
  deliveryContextFromSession,
  sessionDeliveryChannel,
} from "../../utils/delivery-context.read.js";
import { normalizeSessionRowChatType, normalizeText } from "./session-accessor.sqlite-normalize.js";
import type { SessionTranscriptStats } from "./session-accessor.types.js";
import type { SessionActorMemoryWindow } from "./session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import type {
  SessionActorMemoryUsageCommand,
  SessionActorMemoryUsageQuery,
  SessionActorMemoryUsageSnapshot,
} from "./session-actor-memory-usage-contract.js";
import { selectMemorySessionTargets } from "./session-memory-targets-policy.js";
import type { MemorySessionTarget } from "./session-memory-targets.types.js";
import { resolveSessionWindowCreatedAt } from "./session-window-created-at.js";

export function readSessionActorMemoryTranscriptStats(
  window: SessionActorMemoryWindow,
): SessionTranscriptStats {
  const updatedAt = window.hot.transcript.version.updatedAt;
  return {
    eventCount: window.events.length,
    maxSeq: window.events.at(-1)?.rawSeq ?? 0,
    sizeBytes:
      window.events.reduce((bytes, row) => bytes + Buffer.byteLength(row.eventJson), 0) +
      Math.max(0, window.events.length - 1),
    ...(updatedAt === null
      ? {}
      : {
          lastMutationAtMs: updatedAt,
          lastObservedMutationAtMs: updatedAt,
        }),
  };
}

function windows(context: SessionActorMemoryStorageContext) {
  const result: Array<{
    sessionKey: string;
    window: SessionActorMemoryWindow;
    historical: boolean;
  }> = [];
  for (const [sessionKey, state] of context.entries()) {
    if (!state.hot.entry) {
      continue;
    }
    // get() applies the disclosure policy once to each selected session owner.
    context.get(sessionKey);
    result.push({ sessionKey, window: state, historical: false });
    for (const window of state.historicalWindows.values()) {
      result.push({ sessionKey, window, historical: true });
    }
  }
  return result;
}

export function readSessionActorMemoryUsage(
  context: SessionActorMemoryStorageContext,
  query: SessionActorMemoryUsageQuery,
): SessionTranscriptCorpusEntry[] | SessionActorMemoryUsageSnapshot[] | MemorySessionTarget[] {
  if (
    query.type === "session.memory.targets" &&
    !query.input.selectors.sessionIds?.length &&
    !query.input.selectors.hookSources?.length &&
    !query.input.selectors.participants?.length
  ) {
    return [];
  }
  const selected = windows(context);
  if (query.type === "session.memory.targets") {
    return selectMemorySessionTargets(query.input.selectors, {
      instances: selected.flatMap(({ sessionKey, window }) => {
        const entry = window.hot.entry;
        return entry
          ? [
              {
                agentId: context.agentId,
                sessionId: entry.sessionId,
                sessionKey,
                entry,
                acpOwned: Boolean(entry.acp),
                provenanceKnown: true,
                updatedAtMs: window.hot.transcript.version.updatedAt ?? entry.updatedAt,
                sourceMetadata: {
                  createdAt:
                    window.sourceCreatedAt ?? resolveSessionWindowCreatedAt(entry, entry.updatedAt),
                  channel: normalizeText(sessionDeliveryChannel(entry)),
                  accountId: normalizeText(deliveryContextFromSession(entry)?.accountId),
                  chatType: normalizeSessionRowChatType(entry.chatType),
                  hookExternalContentSource: entry.hookExternalContentSource ?? null,
                },
              },
            ]
          : [];
      }),
      participants: new Map(
        [...context.entries()].map(([key, state]) => [
          key,
          state.hot.participants.map(({ identity }) => identity),
        ]),
      ),
      archives: [],
    });
  }

  if (query.type === "session.usage.snapshot") {
    const ids = query.input.sessionIds && new Set(query.input.sessionIds);
    return selected.flatMap(({ sessionKey, window }) => {
      const entry = window.hot.entry;
      if (!entry || (ids && !ids.has(entry.sessionId))) {
        return [];
      }
      return [
        {
          sessionKey,
          sessionId: entry.sessionId,
          updatedAtMs: window.hot.transcript.version.updatedAt ?? entry.updatedAt,
          stats: readSessionActorMemoryTranscriptStats(window),
          rollup: window.usageRollup && {
            valueJson: window.usageRollup.valueJson,
            updatedAt: window.usageRollup.updatedAt,
            ...(query.input.includeRollupBodies ? { blob: window.usageRollup.blob } : {}),
          },
          ...(query.input.includeEvents
            ? {
                events: window.events.map(({ rawSeq, eventJson }) => ({ seq: rawSeq, eventJson })),
              }
            : {}),
        },
      ];
    });
  }
  const lineage = collectCronGeneratedSessionKeys(
    [
      ...selected.filter(({ historical }) => historical),
      ...selected.filter(({ historical }) => !historical),
    ].flatMap(({ sessionKey, window }) =>
      window.hot.entry ? [{ sessionKey, entry: window.hot.entry }] : [],
    ),
  );
  return selected.flatMap(({ sessionKey, window, historical }): SessionTranscriptCorpusEntry[] => {
    const entry = window.hot.entry;
    if (!entry || (historical && !query.input.options.includeRetainedSqlite)) {
      return [];
    }
    const stats = readSessionActorMemoryTranscriptStats(window);
    const classification = classifySessionEntry(sessionKey, entry, lineage);
    return [
      {
        agentId: context.agentId,
        sessionKey,
        sessionId: entry.sessionId,
        sessionFile: sessionKey,
        storePath: context.path,
        transcriptSource: "sqlite",
        artifactKind: historical ? "retained-session" : "active-session",
        updatedAtMs: window.hot.transcript.version.updatedAt ?? entry.updatedAt,
        ...(query.input.options.includeContentRevision === false
          ? {}
          : {
              contentRevision: [
                "sqlite",
                stats.maxSeq,
                stats.sizeBytes,
                stats.eventCount,
                stats.lastMutationAtMs ?? "",
                stats.lastObservedMutationAtMs ?? "",
              ].join(":"),
            }),
        ...(classification.generatedByDreamingNarrative
          ? { generatedByDreamingNarrative: true }
          : {}),
        ...(classification.generatedByCronRun ? { generatedByCronRun: true } : {}),
        sessionKind: classification.sessionKind,
      },
    ];
  });
}

export function mutateSessionActorMemoryUsage(
  context: SessionActorMemoryStorageContext,
  command: SessionActorMemoryUsageCommand,
): boolean {
  const sessionId = command.input.sessionId;
  for (const [sessionKey, state] of context.entries()) {
    const current = state.hot.entry?.sessionId === sessionId;
    const historical = state.historicalWindows.get(sessionId);
    if (!current && !historical) {
      continue;
    }
    const working = context.edit(sessionKey);
    const usageRollup = structuredClone(command.input.rollup);
    if (current) {
      working.usageRollup = usageRollup;
    } else {
      working.historicalWindows.set(sessionId, { ...historical!, usageRollup });
    }
    return true;
  }
  return false;
}
