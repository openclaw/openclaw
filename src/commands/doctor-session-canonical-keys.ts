import fs from "node:fs";
import path from "node:path";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  applySessionEntryLifecycleMutation,
  copySessionOwnedStateForCanonicalRepair,
  listSessionEntriesForCanonicalRepair,
  listSessionGenerationIdsForCanonicalRepair,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import type { SessionEntryLifecycleRemoval } from "../config/sessions/session-accessor.lifecycle-types.js";
import { writeSqliteTranscriptArchive } from "../config/sessions/session-accessor.sqlite-archive.js";
import {
  copySessionNodeArtifactsForRepair,
  deleteSessionMembersForRepair,
} from "../config/sessions/session-accessor.sqlite-node-artifacts.js";
import { mergeCanonicalSessionEntryCandidates } from "../config/sessions/session-canonical-key.js";
import { setCanonicalSqliteSessionMainKey } from "../config/sessions/session-canonical-key.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import { serializeJsonlLines } from "../config/sessions/transcript-jsonl.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSessionStoreAgentId,
  resolveStoredSessionKeyForAgentStore,
} from "../gateway/session-store-key.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";

type CanonicalSessionCandidate = {
  agentId: string;
  canonicalKey: string;
  entry: SessionEntry;
  expectedEntry: SessionEntry;
  lineageRepairRequired: boolean;
  rawEntryJson?: string;
  sessionKey: string;
  sqlitePath: string;
  storePath: string;
};

function createCanonicalRepairRemoval(
  candidate: CanonicalSessionCandidate,
  params: { archiveRemovedTranscript: boolean; deleteOwnedWindows: boolean },
): SessionEntryLifecycleRemoval {
  const removal = {
    archiveRemovedTranscript: params.archiveRemovedTranscript,
    deleteOwnedWindows: params.deleteOwnedWindows,
    exactStoredKey: true,
    expectedEntry: candidate.expectedEntry,
    sessionKey: candidate.sessionKey,
  } satisfies SessionEntryLifecycleRemoval;
  return candidate.rawEntryJson === undefined
    ? removal
    : Object.assign(removal, { expectedRawEntryJson: candidate.rawEntryJson });
}

export type CanonicalSessionKeyRepairReport = {
  archivedTranscriptDirectories: string[];
  foundGroups: number;
  removedRows: number;
  repairedGroups: number;
  scannedStores: number;
};

type CanonicalSessionStore = {
  agentId: string;
  sqlitePath: string;
  storePath: string;
};

function listCanonicalSessionStores(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): CanonicalSessionStore[] {
  const stores: CanonicalSessionStore[] = [];
  const seenDatabases = new Set<string>();
  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env })) {
    const sqlitePath = resolveTargetSqlitePath(target);
    if (seenDatabases.has(sqlitePath) || !fs.existsSync(sqlitePath)) {
      continue;
    }
    seenDatabases.add(sqlitePath);
    stores.push({ agentId: target.agentId, sqlitePath, storePath: target.storePath });
  }
  return stores;
}

function collectCanonicalSessionCandidates(
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
  stores: readonly CanonicalSessionStore[],
): CanonicalSessionCandidate[] {
  const candidates: CanonicalSessionCandidate[] = [];
  for (const target of stores) {
    for (const { entry, rawEntryJson, sessionKey } of listSessionEntriesForCanonicalRepair({
      agentId: target.agentId,
      clone: false,
      storePath: target.storePath,
    })) {
      const canonicalKey = resolveStoredSessionKeyForAgentStore({
        cfg: params.cfg,
        agentId: target.agentId,
        sessionKey,
      });
      const canonicalAgentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
      const canonicalizeLineageKey = (value: string | undefined) =>
        value
          ? resolveStoredSessionKeyForAgentStore({
              cfg: params.cfg,
              agentId: canonicalAgentId,
              sessionKey: value,
            })
          : undefined;
      const parentSessionKey = canonicalizeLineageKey(entry.parentSessionKey);
      const spawnedBy = canonicalizeLineageKey(entry.spawnedBy);
      const normalizedEntry = { ...entry };
      if (parentSessionKey) {
        normalizedEntry.parentSessionKey = parentSessionKey;
      } else {
        delete normalizedEntry.parentSessionKey;
      }
      if (spawnedBy) {
        normalizedEntry.spawnedBy = spawnedBy;
      } else {
        delete normalizedEntry.spawnedBy;
      }
      const lineageRepairRequired =
        parentSessionKey !== entry.parentSessionKey || spawnedBy !== entry.spawnedBy;
      candidates.push({
        agentId: target.agentId,
        canonicalKey,
        entry: normalizedEntry,
        expectedEntry: entry,
        lineageRepairRequired,
        ...(rawEntryJson !== undefined ? { rawEntryJson } : {}),
        sessionKey,
        sqlitePath: target.sqlitePath,
        storePath: target.storePath,
      });
    }
  }
  return candidates;
}

function resolveCanonicalDestination(params: {
  canonicalKey: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  sourceAgentId?: string;
}) {
  const agentId =
    params.canonicalKey === "global" || params.canonicalKey === "unknown"
      ? normalizeAgentId(
          params.sourceAgentId ?? resolveSessionStoreAgentId(params.cfg, params.canonicalKey),
        )
      : resolveSessionStoreAgentId(params.cfg, params.canonicalKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId, env: params.env });
  return {
    agentId,
    storePath,
    sqlitePath: resolveTargetSqlitePath({ agentId, storePath }),
  };
}

function selectCanonicalSessionCandidate(
  candidates: readonly CanonicalSessionCandidate[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
) {
  const first = candidates[0];
  if (!first) {
    return undefined;
  }
  const destination = resolveCanonicalDestination({
    canonicalKey: first.canonicalKey,
    cfg: params.cfg,
    env: params.env,
    sourceAgentId: first.agentId,
  });
  const selected = mergeCanonicalSessionEntryCandidates(
    candidates.map((candidate) => ({
      entry: candidate.entry,
      preferred:
        candidate.sqlitePath === destination.sqlitePath &&
        candidate.sessionKey === candidate.canonicalKey,
      value: candidate,
    })),
  );
  return selected ? { ...selected, destination } : undefined;
}

function groupRepairCandidates(
  candidates: readonly CanonicalSessionCandidate[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
) {
  const byCanonicalKey = new Map<string, CanonicalSessionCandidate[]>();
  for (const candidate of candidates) {
    const sentinelOwner =
      candidate.canonicalKey === "global" || candidate.canonicalKey === "unknown"
        ? candidate.agentId
        : "";
    const groupKey = `${candidate.canonicalKey}\0${sentinelOwner}`;
    const group = byCanonicalKey.get(groupKey) ?? [];
    group.push(candidate);
    byCanonicalKey.set(groupKey, group);
  }
  return [...byCanonicalKey.values()].filter((group) => {
    const first = group[0];
    if (!first) {
      return false;
    }
    const destination = resolveCanonicalDestination({
      canonicalKey: first.canonicalKey,
      cfg: params.cfg,
      env: params.env,
      sourceAgentId: first.agentId,
    });
    return (
      group.length > 1 ||
      group.some(
        (candidate) =>
          candidate.rawEntryJson !== undefined ||
          candidate.lineageRepairRequired ||
          candidate.sessionKey !== candidate.canonicalKey ||
          candidate.sqlitePath !== destination.sqlitePath,
      )
    );
  });
}

function countRemovedRows(
  candidates: readonly CanonicalSessionCandidate[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
): number {
  const selected = selectCanonicalSessionCandidate(candidates, params);
  if (!selected) {
    return 0;
  }
  const canonicalRowSurvives =
    selected.winner.sqlitePath === selected.destination.sqlitePath &&
    selected.winner.sessionKey === selected.winner.canonicalKey;
  return candidates.length - (canonicalRowSurvives ? 1 : 0);
}

async function repairCanonicalSessionGroup(
  candidates: readonly CanonicalSessionCandidate[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
): Promise<string[]> {
  const selected = selectCanonicalSessionCandidate(candidates, params);
  if (!selected) {
    return [];
  }
  const winner = selected.winner;
  const destination = selected.destination;
  const byDatabase = new Map<string, CanonicalSessionCandidate[]>();
  for (const candidate of candidates) {
    const group = byDatabase.get(candidate.sqlitePath) ?? [];
    group.push(candidate);
    byDatabase.set(candidate.sqlitePath, group);
  }

  const destinationStore = byDatabase.get(destination.sqlitePath) ?? [];
  const preArchivedDirectories: string[] = [];
  if (winner.sqlitePath !== destination.sqlitePath) {
    const winnerStore = byDatabase.get(winner.sqlitePath) ?? [winner];
    const generationIds = new Set([
      ...listSessionGenerationIdsForCanonicalRepair({
        agentId: winner.agentId,
        canonicalKey: winner.canonicalKey,
        sourceKeys: winnerStore.map((candidate) => candidate.sessionKey),
        storePath: winner.storePath,
      }),
      winner.entry.sessionId,
    ]);
    for (const sessionId of generationIds) {
      if (!sessionId) {
        continue;
      }
      const destinationCollision = destinationStore.find(
        (candidate) => candidate.entry.sessionId === sessionId,
      );
      const sourceCollision = winnerStore.find(
        (candidate) => candidate.entry.sessionId === sessionId,
      );
      const [destinationEvents, sourceEvents] = await Promise.all([
        loadTranscriptEvents({
          agentId: destinationCollision?.agentId ?? destination.agentId,
          sessionId,
          sessionKey: destinationCollision?.sessionKey ?? winner.canonicalKey,
          storePath: destinationCollision?.storePath ?? destination.storePath,
        }),
        loadTranscriptEvents({
          agentId: sourceCollision?.agentId ?? winner.agentId,
          sessionId,
          sessionKey: sourceCollision?.sessionKey ?? winner.sessionKey,
          storePath: sourceCollision?.storePath ?? winner.storePath,
        }),
      ]);
      const destinationContent = serializeJsonlLines(
        destinationEvents.map((event) => JSON.stringify(event)),
      );
      const sourceContent = serializeJsonlLines(sourceEvents.map((event) => JSON.stringify(event)));
      if (!destinationContent || destinationContent === sourceContent) {
        continue;
      }
      const sqliteDirectory = path.dirname(destination.sqlitePath);
      const archiveDirectory =
        path.basename(sqliteDirectory) === "agent"
          ? path.join(path.dirname(sqliteDirectory), "sessions")
          : sqliteDirectory;
      writeSqliteTranscriptArchive({
        archiveDirectory,
        content: destinationContent,
        reason: "deleted",
        sessionId,
      });
      if (!preArchivedDirectories.includes(archiveDirectory)) {
        preArchivedDirectories.push(archiveDirectory);
      }
    }
  }
  const relatedSessionIds = new Set(
    [selected.entry.sessionId, selected.entry.previousSessionId].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  setCanonicalSqliteSessionMainKey(
    openOpenClawAgentDatabase({ agentId: destination.agentId, path: destination.sqlitePath }),
    params.cfg.session?.mainKey,
  );
  const winnerResult = await applySessionEntryLifecycleMutation({
    agentId: destination.agentId,
    allowCanonicalRepair: true,
    afterUpsertsInTransaction: (destinationDatabase) => {
      const destinationAliasKeys = destinationStore
        .map((candidate) => candidate.sessionKey)
        .filter((sessionKey) => sessionKey !== winner.canonicalKey);
      if (destinationAliasKeys.length > 0) {
        copySessionNodeArtifactsForRepair(
          destinationDatabase,
          destinationDatabase,
          destinationAliasKeys,
          winner.canonicalKey,
          { includeMembers: false },
        );
      }
      if (
        winner.sqlitePath === destination.sqlitePath &&
        winner.sessionKey !== winner.canonicalKey
      ) {
        deleteSessionMembersForRepair(destinationDatabase, winner.canonicalKey);
        copySessionNodeArtifactsForRepair(
          destinationDatabase,
          destinationDatabase,
          [winner.sessionKey],
          winner.canonicalKey,
        );
      }
      for (const [sqlitePath, storeCandidates] of byDatabase) {
        if (sqlitePath === destination.sqlitePath) {
          continue;
        }
        const [source] = storeCandidates;
        if (!source) {
          continue;
        }
        copySessionOwnedStateForCanonicalRepair({
          canonicalKey: winner.canonicalKey,
          destinationDatabase,
          preferSource: sqlitePath === winner.sqlitePath,
          ...(sqlitePath === winner.sqlitePath ? { preferredEntry: selected.entry } : {}),
          ...(sqlitePath === winner.sqlitePath ? { preferredSessionKey: winner.sessionKey } : {}),
          source,
          sourceEntries: storeCandidates.map((candidate) => candidate.entry),
          sourceKeys: storeCandidates.map((candidate) => candidate.sessionKey),
        });
      }
    },
    removals: destinationStore
      .filter(
        (candidate) =>
          candidate.sessionKey !== winner.canonicalKey || candidate.rawEntryJson !== undefined,
      )
      .map((candidate) =>
        createCanonicalRepairRemoval(candidate, {
          archiveRemovedTranscript: !relatedSessionIds.has(candidate.entry.sessionId),
          deleteOwnedWindows: false,
        }),
      ),
    skipMaintenance: true,
    storePath: destination.storePath,
    upserts: [{ entry: selected.entry, sessionKey: winner.canonicalKey }],
  });
  const archivedDirectories = new Set([
    ...preArchivedDirectories,
    ...winnerResult.archivedTranscriptDirectories,
  ]);

  for (const [sqlitePath, storeCandidates] of byDatabase) {
    if (sqlitePath === destination.sqlitePath) {
      continue;
    }
    const [storeCandidate] = storeCandidates;
    if (!storeCandidate) {
      continue;
    }
    const result = await applySessionEntryLifecycleMutation({
      agentId: storeCandidate.agentId,
      removals: storeCandidates.map((candidate) =>
        createCanonicalRepairRemoval(candidate, {
          archiveRemovedTranscript: true,
          deleteOwnedWindows: true,
        }),
      ),
      skipMaintenance: true,
      storePath: storeCandidate.storePath,
    });
    for (const directory of result.archivedTranscriptDirectories) {
      archivedDirectories.add(directory);
    }
  }
  return [...archivedDirectories];
}

/** Doctor-owned durable repair; process-held incognito databases are intentionally excluded. */
export async function repairCanonicalSessionKeys(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<CanonicalSessionKeyRepairReport> {
  const env = params.env ?? process.env;
  const stores = listCanonicalSessionStores({
    cfg: params.cfg,
    env,
  });
  const archivedTranscriptDirectories = new Set<string>();
  let repairedGroups = 0;
  if (params.apply) {
    for (const store of stores) {
      setCanonicalSqliteSessionMainKey(
        openOpenClawAgentDatabase({ agentId: store.agentId, path: store.sqlitePath }),
        params.cfg.session?.mainKey,
      );
    }
  }
  const candidates = collectCanonicalSessionCandidates({ cfg: params.cfg, env }, stores);
  const repairGroups = groupRepairCandidates(candidates, { cfg: params.cfg, env });
  if (params.apply) {
    for (const group of repairGroups) {
      for (const directory of await repairCanonicalSessionGroup(group, {
        cfg: params.cfg,
        env,
      })) {
        archivedTranscriptDirectories.add(directory);
      }
      repairedGroups += 1;
    }
  }
  return {
    archivedTranscriptDirectories: [...archivedTranscriptDirectories].toSorted(),
    foundGroups: repairGroups.length,
    removedRows: repairGroups.reduce(
      (total, group) => total + countRemovedRows(group, { cfg: params.cfg, env }),
      0,
    ),
    repairedGroups,
    scannedStores: stores.length,
  };
}
