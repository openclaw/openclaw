import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  listMemorySessionStoreTargets,
  type GatewayStoredSessionTarget,
} from "../../config/sessions/combined-store-gateway.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/legacy-sqlite-marker.js";
import {
  resolveSessionFilePathCore,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import { captureMemoryExactSessionReader } from "../../config/sessions/session-accessor.memory-exact-read.js";
import {
  resolveSessionCreatorActor,
  sessionCreatorProfileId,
} from "../../config/sessions/session-entry-provenance.js";
import { withSessionHistoryWorkerDatabases } from "../../config/sessions/session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "../../config/sessions/transcript-target-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveUsageSessionSource } from "../../infra/session-cost-usage.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../../sessions/session-id-resolution.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { UNKNOWN_USAGE_CREATOR_KEY } from "../../shared/usage-aggregates.js";
import type { SessionUsageCreator } from "../../shared/usage-types.js";
import {
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.read.js";
import { projectSessionActor } from "../session-identity-projection.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import { resolveGatewaySessionDisplayName } from "../session-utils-display.js";
import { prepareSessionRowSelection } from "../session-utils-list.js";
import { findCanonicalStoreMatch } from "../session-utils-store-selection.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import {
  discoverAllSessionsForUsage,
  type UsageSessionSummaryTarget,
} from "./usage-session-loading.js";

export class UsageSessionInvalidRequestError extends Error {}

type ResolvedSessionUsageTarget = {
  entry: SessionEntry | undefined;
  agentId: string;
  sessionId: string;
  sessionFile: string;
};

export async function resolveSessionUsageTarget(
  key: string,
  config: OpenClawConfig,
  agentIdHint?: string,
): Promise<ResolvedSessionUsageTarget | undefined> {
  const signal = getAsyncWorkSignal();
  const target = await resolveGatewaySessionStoreTargetInWorker({
    cfg: config,
    key,
    ...(agentIdHint ? { agentId: agentIdHint } : {}),
    assertActive: () => signal?.throwIfAborted(),
  });
  const { canonicalKey, storePath } = target;
  const entry = findCanonicalStoreMatch(target.store, target.storeKeys)?.entry;
  const parsed = parseAgentSessionKey(key);
  const agentId =
    parsed?.agentId ?? agentIdHint ?? resolveSessionAgentId({ config, sessionKey: key });
  const sessionId = entry?.sessionId ?? parsed?.rest ?? key;
  const source = await resolveUsageSessionSource({
    agentId,
    sessionId,
    ...(entry
      ? {
          sessionTarget: {
            agentId,
            sessionId,
            sessionKey: canonicalKey,
            storePath: target.readSource?.path ?? storePath,
          },
        }
      : {
          sessionFile: resolveSessionFilePathCore(
            sessionId,
            undefined,
            resolveSessionFilePathOptions({ storePath, agentId }),
          ),
        }),
  });
  signal?.throwIfAborted();
  return source
    ? { entry: source.entry, agentId, sessionId, sessionFile: source.sessionFile }
    : undefined;
}

export type UsageGroupingMode = "instance" | "family";

export type UsageSessionSelection = UsageSessionSummaryTarget & {
  key: string;
  label?: string;
  updatedAt: number;
  storeEntry?: SessionEntry;
  /** Recorded lineage attribution when a retained instance has no current store row. */
  creatorEntry?: SessionEntry;
  scope?: "instance" | "family";
  sessionFamilyKey?: string;
  currentSessionId?: string;
  includedSessionIds?: string[];
  contextTarget?: { storeTarget: GatewayStoredSessionTarget["storeTarget"]; storedKey: string };
  contextWeight?: SessionEntry["systemPromptReport"];
};

export function projectUsageCreator(
  session: UsageSessionSelection,
  profiles: Parameters<typeof projectSessionActor>[1],
  config: OpenClawConfig,
): SessionUsageCreator {
  const entry = session.storeEntry ?? session.creatorEntry;
  const actor = resolveSessionCreatorActor(entry?.createdActor);
  if (!actor) {
    return { key: UNKNOWN_USAGE_CREATOR_KEY };
  }
  const projected = projectSessionActor(
    actor,
    profiles,
    config,
    Boolean(sessionCreatorProfileId(actor)),
  );
  if (!projected?.id && actor.type !== "system") {
    return { key: UNKNOWN_USAGE_CREATOR_KEY };
  }
  const identity = projected?.identity;
  const origin = sessionDeliveryOrigin(entry);
  const channel = sessionDeliveryChannel(entry);
  if (actor.type === "human" && actor.source !== "profile" && !channel) {
    return { key: UNKNOWN_USAGE_CREATOR_KEY };
  }
  const key =
    identity?.type === "profile"
      ? JSON.stringify(["profile", identity.id])
      : actor.type === "human"
        ? JSON.stringify([
            "human",
            actor.source,
            session.agentId,
            channel ?? null,
            origin?.accountId ?? null,
            projected?.id,
          ])
        : actor.type === "agent"
          ? JSON.stringify([identity?.type ?? "agent", identity?.id ?? projected?.id])
          : JSON.stringify(["system", projected?.id ?? null]);
  return { key, ...(projected ? { actor: projected } : {}) };
}

function usageSessionIdentity(agentId: string, sessionId: string): string {
  return `${agentId}\0${sessionId}`;
}

type StoredUsageSession = { key: string; entry: SessionEntry };
type UsageSessionTarget = Pick<GatewayStoredSessionTarget, "agentId" | "storeTarget" | "storeKey">;
type UsageSessionVisibility = (
  key: string,
  entry: SessionEntry,
  target?: UsageSessionTarget,
) => boolean;

function buildStoreBySessionIdentity(
  store: Record<string, SessionEntry>,
  targetsBySessionKey: ReadonlyMap<string, UsageSessionTarget>,
) {
  const matchesByIdentity = new Map<string, Array<[string, SessionEntry]>>();
  for (const [key, entry] of Object.entries(store)) {
    if (!entry?.sessionId) {
      continue;
    }
    const agentId = expectDefined(targetsBySessionKey.get(key), "stored session owner").agentId;
    const identity = usageSessionIdentity(agentId, entry.sessionId);
    const matches = matchesByIdentity.get(identity) ?? [];
    matches.push([key, entry]);
    matchesByIdentity.set(identity, matches);
  }

  const storeByIdentity = new Map<string, StoredUsageSession>();
  for (const [identity, matches] of matchesByIdentity) {
    // Aliases within one agent share a transcript; another agent's identical id does not.
    const sessionId = expectDefined(matches[0], "stored session match")[1].sessionId;
    const preferredKey = resolvePreferredSessionKeyForSessionIdMatches(matches, sessionId);
    if (!preferredKey) {
      continue;
    }
    const preferredEntry = store[preferredKey];
    if (preferredEntry) {
      storeByIdentity.set(identity, { key: preferredKey, entry: preferredEntry });
    }
  }
  const familyMatches = new Map<
    string,
    { sessionId: string; matches: Array<[string, SessionEntry]> }
  >();
  for (const { key, entry } of storeByIdentity.values()) {
    const agentId = expectDefined(targetsBySessionKey.get(key), "stored session owner").agentId;
    for (const sessionId of entry.usageFamilySessionIds ?? []) {
      const identity = usageSessionIdentity(agentId, sessionId);
      if (!storeByIdentity.has(identity)) {
        const candidates = familyMatches.get(identity) ?? { sessionId, matches: [] };
        candidates.matches.push([key, entry]);
        familyMatches.set(identity, candidates);
      }
    }
  }
  // Direct current owners beat recorded history (for example cron continuation
  // aliases). Ambiguous history stays an instance rather than being counted twice.
  const familyOwners = new Map(storeByIdentity);
  for (const [identity, { sessionId, matches }] of familyMatches) {
    const key = resolvePreferredSessionKeyForSessionIdMatches(matches, sessionId);
    if (key) {
      familyOwners.set(identity, { key, entry: expectDefined(store[key], "family owner") });
    }
  }
  return { storeByIdentity, familyOwners };
}

export async function selectUsageSessions(params: {
  config: OpenClawConfig;
  projection: SessionRowProjection;
  agentId?: string;
  specificKey: string | null;
  groupingMode: UsageGroupingMode;
  startMs: number;
  endMs: number;
  visibilityFilter?: UsageSessionVisibility;
  /** Overview reads judge freshness in the cache worker, without transcript statistics. */
  statistics?: false;
}): Promise<UsageSessionSelection[]> {
  const {
    config,
    projection,
    agentId: effectiveAgentId,
    specificKey,
    groupingMode,
    startMs,
    endMs,
    visibilityFilter,
  } = params;
  await projection.prepareSelection({ metadataOnly: true });
  if (visibilityFilter) {
    await projection.prepareMembership();
  }
  const selection = prepareSessionRowSelection(
    projection,
    effectiveAgentId ? { agentId: effectiveAgentId } : {},
    { metadataPrepared: true },
  );
  const store: Record<string, SessionEntry> = {};
  const targetsBySessionKey = new Map<string, UsageSessionTarget>();
  for (const [key, entry] of selection.entries("all")) {
    store[key] = entry;
    targetsBySessionKey.set(key, selection.getTarget(key)!);
  }
  // Private sessions remain with their process-local owner, outside the resident roster.
  for (const target of listMemorySessionStoreTargets()) {
    if (effectiveAgentId && target.agentId !== effectiveAgentId) {
      continue;
    }
    for (const { sessionKey, entry } of captureMemoryExactSessionReader(target)?.entries("list") ??
      []) {
      if (isIncognitoSessionKey(sessionKey) && entry.incognito === true) {
        store[sessionKey] = entry;
        targetsBySessionKey.set(sessionKey, { agentId: target.agentId, storeTarget: target });
      }
    }
  }
  const scopedStore = Object.fromEntries(
    Object.entries(store).filter(
      ([key, entry]) =>
        (!effectiveAgentId || targetsBySessionKey.get(key)?.agentId === effectiveAgentId) &&
        (!visibilityFilter || visibilityFilter(key, entry, targetsBySessionKey.get(key))),
    ),
  );
  const { storeByIdentity: storeBySessionIdentity, familyOwners } = buildStoreBySessionIdentity(
    scopedStore,
    targetsBySessionKey,
  );
  // Only an individual instance can skip discovery. Families need the actual
  // historical sources, including retained JSONL artifacts beside SQLite windows.
  const discoveredSessions =
    !specificKey || groupingMode === "family"
      ? await discoverAllSessionsForUsage({
          config,
          ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
          startMs,
          endMs,
          statistics: params.statistics,
        })
      : [];
  const discoveredByIdentity = new Map(
    discoveredSessions.map((session) => [
      usageSessionIdentity(session.agentId, session.sessionId),
      session,
    ]),
  );
  function withUsageGrouping(
    base: Omit<UsageSessionSelection, "instances">,
  ): UsageSessionSelection {
    const currentInstance = {
      sessionId: base.sessionId,
      sessionFile: base.sessionFile,
      transcriptFile: discoveredByIdentity.get(usageSessionIdentity(base.agentId, base.sessionId))
        ?.transcriptFile,
    };
    if (groupingMode !== "family") {
      return { ...base, instances: [currentInstance] };
    }
    // Historical ids belong to this agent; identical ids owned by other agents stay separate.
    const includedSessionIds = [
      ...new Set(
        [base.sessionId, ...(base.storeEntry?.usageFamilySessionIds ?? [])]
          .map(normalizeOptionalString)
          .filter((id): id is string => Boolean(id)),
      ),
    ].filter(
      (id) =>
        id === base.sessionId ||
        familyOwners.get(usageSessionIdentity(base.agentId, id))?.entry.sessionId ===
          base.sessionId,
    );
    return {
      ...base,
      // Discovery owns SQLite/archive precedence; loading must not guess storage
      // from the current instance, because one family can span both sources.
      instances: includedSessionIds.flatMap((id) => {
        const instance =
          id === base.sessionId
            ? currentInstance
            : discoveredByIdentity.get(usageSessionIdentity(base.agentId, id));
        return instance ? [instance] : [];
      }),
      scope: "family",
      sessionFamilyKey: base.storeEntry?.usageFamilyKey ?? base.key,
      currentSessionId: base.sessionId,
      includedSessionIds,
    };
  }
  const now = Date.now();

  const mergedEntries: UsageSessionSelection[] = [];

  if (specificKey) {
    const scopedSpecificKey = resolveStoredSessionKeyForAgentStore({
      cfg: config,
      agentId: expectDefined(effectiveAgentId, "specific session owner"),
      sessionKey: specificKey,
    });
    const scopedParsed = parseAgentSessionKey(scopedSpecificKey);
    const agentIdFromKey =
      scopedParsed?.agentId ?? expectDefined(effectiveAgentId, "specific session owner");
    const keyRest = scopedParsed?.rest ?? specificKey;

    // Prefer the store entry when available, even if the caller provides a discovered key
    // (`agent:<id>:<sessionId>`) for a session that now has a canonical store key.
    const storeMatch = scopedStore[scopedSpecificKey]
      ? { key: scopedSpecificKey, entry: scopedStore[scopedSpecificKey] }
      : scopedStore[specificKey]
        ? { key: specificKey, entry: scopedStore[specificKey] }
        : null;
    const storeByIdMatch =
      storeBySessionIdentity.get(usageSessionIdentity(agentIdFromKey, keyRest)) ??
      (keyRest !== specificKey
        ? storeBySessionIdentity.get(usageSessionIdentity(agentIdFromKey, specificKey))
        : undefined) ??
      null;
    const resolvedStoreKey = storeMatch?.key ?? storeByIdMatch?.key ?? scopedSpecificKey;
    let storeEntry = storeMatch?.entry ?? storeByIdMatch?.entry;
    if (visibilityFilter && !storeEntry) {
      throw new UsageSessionInvalidRequestError(`Invalid session reference: ${specificKey}`);
    }
    const sessionId = storeEntry?.sessionId ?? keyRest;

    // Stored sessions are canonical SQLite targets. JSONL discovery remains only for
    // sessions without a store row, so retired locators cannot redirect live state.
    let sessionFile: string;
    if (storeEntry && !storeEntry.incognito) {
      sessionFile = formatSqliteSessionFileMarker({
        agentId: agentIdFromKey,
        sessionId,
        storePath: targetsBySessionKey.get(resolvedStoreKey)!.storeTarget.storePath,
      });
    } else {
      try {
        const resolved = await resolveSessionUsageTarget(resolvedStoreKey, config, agentIdFromKey);
        if (!resolved || resolved.agentId !== agentIdFromKey || resolved.sessionId !== sessionId) {
          throw new Error("session target mismatch");
        }
        if (
          visibilityFilter &&
          (!resolved.entry ||
            !visibilityFilter(
              resolvedStoreKey,
              resolved.entry,
              targetsBySessionKey.get(resolvedStoreKey),
            ))
        ) {
          throw new Error("session visibility changed");
        }
        sessionFile = resolved.sessionFile;
        storeEntry = resolved.entry;
      } catch {
        getAsyncWorkSignal()?.throwIfAborted();
        throw new UsageSessionInvalidRequestError(`Invalid session reference: ${specificKey}`);
      }
    }

    let updatedAt: number | undefined;
    if (parseSqliteSessionFileMarker(sessionFile)) {
      updatedAt = storeEntry?.updatedAt ?? now;
    } else {
      try {
        const stats = fs.statSync(sessionFile);
        if (stats.isFile()) {
          updatedAt = storeEntry?.updatedAt ?? stats.mtimeMs;
        }
      } catch {
        // File doesn't exist - no results for this key
      }
    }
    if (updatedAt !== undefined) {
      mergedEntries.push(
        withUsageGrouping({
          key: resolvedStoreKey,
          agentId: agentIdFromKey,
          sessionId,
          sessionFile,
          label: resolveGatewaySessionDisplayName(resolvedStoreKey, storeEntry),
          updatedAt,
          storeEntry,
        }),
      );
    }
  } else {
    const selectedFamilies = new Set<string>();
    for (const discovered of discoveredSessions) {
      const identity = usageSessionIdentity(discovered.agentId, discovered.sessionId);
      const owner = (groupingMode === "family" ? familyOwners : storeBySessionIdentity).get(
        identity,
      );
      if (!owner) {
        if (!visibilityFilter) {
          mergedEntries.push({
            key: `agent:${discovered.agentId}:${discovered.sessionId}`,
            agentId: discovered.agentId,
            sessionId: discovered.sessionId,
            sessionFile: discovered.sessionFile,
            instances: [discovered],
            updatedAt: discovered.mtime,
            scope: "instance",
            creatorEntry: familyOwners.get(identity)?.entry,
          });
        }
        continue;
      }
      const { key } = owner;
      let entry = owner.entry;
      const familyIdentity = usageSessionIdentity(discovered.agentId, key);
      if (selectedFamilies.has(familyIdentity)) {
        continue;
      }
      // Rotation can leave the current window empty. A discovered historical
      // member still selects its recorded owner, once per canonical family row.
      let sessionFile = discoveredByIdentity.get(
        usageSessionIdentity(discovered.agentId, entry.sessionId),
      )?.sessionFile;
      if (!sessionFile) {
        if (entry.incognito) {
          const target = await resolveSessionUsageTarget(key, config, discovered.agentId);
          if (
            !target ||
            target.agentId !== discovered.agentId ||
            target.sessionId !== entry.sessionId
          ) {
            throw new UsageSessionInvalidRequestError(`Invalid session reference: ${key}`);
          }
          if (
            visibilityFilter &&
            (!target.entry || !visibilityFilter(key, target.entry, targetsBySessionKey.get(key)))
          ) {
            continue;
          }
          sessionFile = target.sessionFile;
          entry = target.entry ?? entry;
        } else {
          sessionFile = formatSqliteSessionFileMarker({
            agentId: discovered.agentId,
            sessionId: entry.sessionId,
            storePath: targetsBySessionKey.get(key)!.storeTarget.storePath,
          });
        }
      }
      mergedEntries.push(
        withUsageGrouping({
          key,
          agentId: discovered.agentId,
          sessionId: entry.sessionId,
          sessionFile,
          label: resolveGatewaySessionDisplayName(key, entry),
          updatedAt: entry.updatedAt ?? discovered.mtime,
          storeEntry: entry,
        }),
      );
      if (groupingMode === "family") {
        selectedFamilies.add(familyIdentity);
      }
    }
  }

  mergedEntries.sort((a, b) => b.updatedAt - a.updatedAt);

  // Carry physical targets through filtering; only emitted rows will hydrate context.
  for (const row of mergedEntries) {
    const target = targetsBySessionKey.get(row.key);
    if (!target) {
      continue;
    }
    row.contextTarget = { storeTarget: target.storeTarget, storedKey: target.storeKey ?? row.key };
  }

  return mergedEntries;
}

export async function loadUsageSessionContext(
  selected: UsageSessionSelection[],
  visibilityFilter?: UsageSessionVisibility,
): Promise<void> {
  const contextRows = new Map<
    GatewayStoredSessionTarget["storeTarget"],
    Array<{ row: UsageSessionSelection; storedKey: string }>
  >();
  for (const row of selected) {
    const target = row.contextTarget;
    if (target) {
      const rows = contextRows.get(target.storeTarget) ?? [];
      rows.push({ row, storedKey: target.storedKey });
      contextRows.set(target.storeTarget, rows);
    }
  }
  const groups = [...contextRows];
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  const identities = groups.map(([target]) => readDatabasePathIdentitySync(target.storePath));
  await withSessionHistoryWorkerDatabases(
    groups.map(([target]) => ({ agentId: target.agentId, path: target.storePath, env })),
    async (owners) => {
      const reads = [];
      for (const [index, [, rows]] of groups.entries()) {
        reads.push(
          await owners[index]!.readExactEntries({
            env,
            expectedIdentity: identities[index],
            sessionKeys: [...new Set(rows.map(({ storedKey }) => storedKey))],
            projection: "exact",
            snapshotFields: ["systemPromptReport"],
          }),
        );
      }
      for (const owner of owners) {
        owner.assertCurrent();
      }
      for (const [index, [, rows]] of groups.entries()) {
        const entries = new Map(
          reads[index]!.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
        );
        for (const { row, storedKey } of rows) {
          const entry = entries.get(storedKey);
          // Summary loading can yield across a reset or sharing change; never expose its successor's report.
          if (
            entry?.sessionId === row.sessionId &&
            (!visibilityFilter ||
              visibilityFilter(
                row.key,
                entry,
                row.contextTarget && {
                  agentId: row.agentId,
                  storeTarget: row.contextTarget.storeTarget,
                  storeKey: row.contextTarget.storedKey,
                },
              ))
          ) {
            row.contextWeight = entry.systemPromptReport;
          }
        }
      }
    },
  );
}
