import { isDeepStrictEqual } from "node:util";
import { ok } from "@openclaw/normalization-core/result";
import { listAgentIds } from "../agents/agent-scope.js";
import { listSubagentSessionListRunsForControllers } from "../agents/subagents/registry/subagent-registry-read.js";
import { readResolvedSessionEntriesInWorker } from "../config/sessions/session-accessor.entry.js";
import { listSessionChildEntriesReadOnly } from "../config/sessions/session-entry-children-read.js";
import {
  withSessionEntriesFromStoresInWorker,
  withSessionStoreReaderInWorker,
} from "../config/sessions/session-entry-read-runtime.js";
import type {
  PreparedSessionEntryWorkerRead,
  SessionEntryWorkerRead,
} from "../config/sessions/session-entry-read-runtime.types.js";
import type {
  CapturedSessionEntryReadSource,
  SessionEntryReadSource,
} from "../config/sessions/session-entry-read-source.types.js";
import { preparePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "../config/sessions/session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../config/sessions/session-store-target-runtime.js";
import { isConfiguredSessionStoreAgentId } from "../config/sessions/targets-configured-agents.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { prepareOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import type { GatewaySessionStoreDiscoveryCache } from "./session-utils-store-candidates.js";
import { SessionStoreUnavailableError } from "./session-utils-store-error.js";
import {
  prepareGatewaySessionStoreTargetReadOnly,
  prepareGatewaySessionStoreTargetReadPlan,
  resolveNativeGatewaySessionStoreTargetWithStore,
  type GatewaySessionStoreLookupParams,
} from "./session-utils-store-lookup.js";
import type { GatewaySessionStoreRead } from "./session-utils-store-read.js";
import {
  findCanonicalStoreMatch,
  omitInternalSessionEffectsEntries,
} from "./session-utils-store-selection.js";
import type { GatewaySessionStoreTargetWithStore } from "./session-utils-store.types.js";

type GatewaySessionStoreReadPlan = {
  reads: readonly SessionEntryWorkerRead[];
  assertCurrent: () => void;
  selectPrepared: (
    reads: readonly PreparedSessionEntryWorkerRead[],
  ) => GatewaySessionStoreTargetWithStore;
};

export type GatewaySessionEntryReadPlan = {
  reads: readonly SessionEntryWorkerRead[];
  assertCurrent: () => void;
  selectPrepared: (reads: readonly PreparedSessionEntryWorkerRead[]) => SessionEntry | undefined;
};

/** Acquire the ordered lookup's data while its discovery and physical readers remain current. */
export async function resolveGatewaySessionStoreTargetInWorker(
  params: GatewaySessionStoreLookupParams & {
    assertActive?: () => void;
    signal?: AbortSignal;
    onSelected?: (target: GatewaySessionStoreTargetWithStore) => void;
  },
): Promise<GatewaySessionStoreTargetWithStore> {
  let prepared = await prepareGatewaySessionStoreReadInWorker(params, false, params.onSelected);
  if (
    params.readOnly === false &&
    params.clone !== false &&
    !prepared.target.capturedReadSource &&
    !isIncognitoSessionKey(prepared.target.canonicalKey) &&
    isConfiguredSessionStoreAgentId(params.cfg, prepared.target.agentId)
  ) {
    const path =
      prepared.target.readSource?.path ??
      (await preparePhysicalSessionStorePath(
        {
          agentId: prepared.target.agentId,
          sessionKey: prepared.target.canonicalKey,
          env: params.env,
        },
        params.cfg,
      ));
    await prepareOpenClawAgentDatabaseExecution(
      {
        agentId: prepared.target.readSource?.agentId ?? prepared.target.agentId,
        path,
        env: params.env,
      },
      () => params.assertActive?.(),
    );
    prepared = await prepareGatewaySessionStoreReadInWorker(
      { ...params, readOnly: true },
      false,
      params.onSelected,
    );
  }
  const target = await includeDirectChildEntriesInWorker(prepared.target, params);
  params.assertActive?.();
  return target;
}

async function includeDirectChildEntriesInWorker(
  target: GatewaySessionStoreTargetWithStore,
  params: GatewaySessionStoreLookupParams,
): Promise<GatewaySessionStoreTargetWithStore> {
  if (!params.includeStoreChildEntries) {
    return target;
  }
  try {
    const parentKeys = new Set([target.canonicalKey, ...target.storeKeys]);
    const children = await listSessionChildEntriesReadOnly(
      {
        agentId: target.readSource?.agentId ?? target.agentId,
        storePath: target.readSource?.path ?? target.storePath,
        env: params.env,
        projection: "list",
        sessionKey: target.canonicalKey,
      },
      [...parentKeys],
    );
    for (const { sessionKey, entry } of children) {
      target.store[sessionKey] = entry;
    }
    const hintedKeys = [
      ...new Set(
        listSubagentSessionListRunsForControllers([...parentKeys]).map(
          ({ childSessionKey }) => childSessionKey,
        ),
      ),
    ].filter((key) => !target.store[key]);
    if (hintedKeys.length) {
      const retainedChildren = await readResolvedSessionEntriesInWorker(
        {
          cfg: params.cfg,
          env: params.env,
          sessionKeys: hintedKeys,
        },
        "list",
      );
      for (const { canonicalKey, entry } of retainedChildren.values()) {
        if (entry && !parentKeys.has(canonicalKey)) {
          target.store[canonicalKey] = entry;
        }
      }
    }
  } catch {
    // Optional child context keeps the selected parent usable when a child store is unavailable.
  }
  return target;
}

async function prepareGatewaySessionStoreReadInWorker(
  params: Parameters<typeof resolveGatewaySessionStoreTargetInWorker>[0],
  retainPlan = false,
  onSelected?: (target: GatewaySessionStoreTargetWithStore) => void,
): Promise<{ target: GatewaySessionStoreTargetWithStore; readPlan?: GatewaySessionStoreReadPlan }> {
  params.assertActive?.();
  const parsedAgent = parseAgentSessionKey(params.key)?.agentId;
  // A retained retired-owner row is selected before replacement-owner validation.
  const retiredOwner = parsedAgent && !isConfiguredSessionStoreAgentId(params.cfg, parsedAgent);
  const agentId = retiredOwner
    ? parsedAgent
    : resolveSessionStoreIdentity({
        cfg: params.cfg,
        sessionKey: params.key,
        agentId: params.agentId,
        preserveQualifiedAddress: params.preserveQualifiedAddress,
      }).agentId;
  // Ephemeral databases belong to the process and cannot be opened by a worker.
  if (isIncognitoSessionKey(params.key)) {
    const target = resolveNativeGatewaySessionStoreTargetWithStore({
      ...params,
      readOnly: true,
      projection: params.projection ?? "list",
      exactRead: true,
    });
    onSelected?.(target);
    return { target };
  }
  const { candidates, ...inventory } = prepareSessionStoreTargetInventory(
    params.cfg,
    [
      agentId,
      ...(retiredOwner ? listAgentIds(params.cfg) : []),
      ...(parsedAgent && parsedAgent !== agentId ? [parsedAgent] : []),
    ],
    params.env,
  );
  const identities = retainPlan ? captureSessionStoreCandidateIdentities(candidates) : undefined;
  const inventoryRead = prepareSessionStoreTargetInventoryRead({ ...inventory, candidates });
  const captured = new Map<
    GatewaySessionStoreRead,
    {
      input: SessionEntryWorkerRead;
      source: SessionEntryReadSource;
      expectedSource?: CapturedSessionEntryReadSource;
    }
  >();
  const prepared = await inventoryRead.withRead(
    async (sources, assertCurrent) => {
      const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
      for (const source of sources.agents) {
        if (!source.result.available && source.result.reason !== "database-missing") {
          throw new SessionStoreUnavailableError(
            source.agentId,
            source.result.reason,
            source.result.error,
          );
        }
        targetDiscoveryCache.set(source.agentId, {
          existing: source.result.available ? source.result.targets : [],
          fallback: {
            agentId: source.agentId,
            storePath: inventory.paths.get(source.agentId)!.configured,
          },
        });
      }
      const lookup = {
        ...params,
        cfg: inventory.config,
        key: params.key,
        env: inventory.env,
        targetDiscoveryCache,
        exactRead: retainPlan ? true : params.exactRead,
        projection: params.projection,
        preserveQualifiedAddress: params.preserveQualifiedAddress,
      };
      const prepareReads = async <T>(
        reads: readonly GatewaySessionStoreRead[],
        select: () => T,
      ) => {
        assertCurrent();
        const pending = reads.filter((read) => read.result === undefined);
        // The public store-returning API retains its full-store default. Authority plans
        // and explicit exact reads keep the bounded row operation below.
        if (pending.some((read) => read.options.exactKeys === undefined)) {
          const readNext = async (index: number): Promise<T> => {
            const read = pending[index];
            if (!read) {
              return select();
            }
            return withSessionStoreReaderInWorker(
              { agentId: read.agentId ?? agentId, storePath: read.storePath, env: inventory.env },
              async ({ reader, database, continuation, assertCurrent: assertSourceCurrent }) => {
                const result = await reader.readEntries(
                  {
                    agentId: database.agentId,
                    storePath: database.path,
                    env: database.env,
                    projection: read.options.projection === "list" ? "list" : "full",
                    sessionKeys: read.options.exactKeys,
                  },
                  continuation,
                );
                assertSourceCurrent();
                read.result = ok(
                  Object.fromEntries(
                    result.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
                  ),
                );
                read.readSource = { agentId: database.agentId, path: database.path };
                read.capturedReadSource = result.source;
                return readNext(index + 1);
              },
              { dataOnly: true },
            );
          };
          return readNext(0);
        }
        return await withSessionEntriesFromStoresInWorker(
          pending.map((read) => ({
            agentId: read.agentId ?? agentId,
            storePath: read.storePath,
            sessionKeys: read.options.exactKeys!,
            projection: read.options.projection === "list" ? ("list" as const) : ("exact" as const),
            snapshotFields:
              typeof read.options.projection === "object" ? read.options.projection : undefined,
            env: inventory.env,
          })),
          (loaded) => {
            assertCurrent();
            for (const [index, read] of pending.entries()) {
              const preparedRead = loaded[index]!;
              read.result = ok(
                Object.fromEntries(
                  preparedRead.result.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
                ),
              );
              read.readSource = {
                agentId: preparedRead.database.agentId,
                path: preparedRead.database.path,
              };
              const identity = readDatabasePathIdentitySync(preparedRead.database.path);
              preparedRead.assertCurrent();
              if (identity.key.startsWith("file:")) {
                read.capturedReadSource = {
                  ...read.readSource,
                  databaseIdentity: identity.key.slice("file:".length),
                  databaseBirthtime: identity.birthtime,
                };
              }
              if (retainPlan) {
                captured.set(read, {
                  input: {
                    agentId: preparedRead.database.agentId,
                    storePath: preparedRead.database.path,
                    sessionKeys: [...read.options.exactKeys!],
                    projection: "exact",
                    env: inventory.env,
                  },
                  source: read.readSource,
                  expectedSource: read.capturedReadSource,
                });
              }
            }
            return select();
          },
          { ordered: onSelected !== undefined, signal: params.signal },
        );
      };
      const selected =
        retainPlan || onSelected
          ? await prepareGatewaySessionStoreTargetReadPlan(lookup, prepareReads, onSelected)
          : {
              target: await prepareGatewaySessionStoreTargetReadOnly(lookup, prepareReads),
              plan: undefined,
            };
      assertCurrent();
      return selected;
    },
    params.assertActive,
    params.signal,
  );
  params.assertActive?.();
  if (!retainPlan || !prepared.plan) {
    return { target: prepared.target };
  }
  const assertCurrent = () => {
    inventoryRead.assertRegistryCurrent();
    for (const candidate of candidates) {
      assertSessionStoreReadCandidate(candidate.path, candidates);
    }
    if (!isDeepStrictEqual(captureSessionStoreCandidateIdentities(candidates), identities)) {
      throw new Error("Prepared session lookup candidates changed");
    }
  };
  const { target: initialTarget, plan } = prepared;
  const selectedSource = {
    agentId: initialTarget.agentId,
    canonicalKey: initialTarget.canonicalKey,
    storePath: initialTarget.storePath,
    readSource: initialTarget.readSource,
  };
  const reads = plan.reads.map((read) => {
    const source = captured.get(read);
    if (!source) {
      throw new Error("Prepared session lookup source is unavailable");
    }
    return { read, ...source };
  });
  const select = (
    snapshots: readonly {
      entries: readonly { sessionKey: string; entry: SessionEntry }[];
      source: SessionEntryReadSource;
      capturedReadSource?: CapturedSessionEntryReadSource;
      assertCurrent: () => void;
    }[],
  ) => {
    assertCurrent();
    if (snapshots.length !== reads.length) {
      throw new Error("Prepared session lookup facts are incomplete");
    }
    try {
      for (const [index, { read, source, expectedSource }] of reads.entries()) {
        const current = snapshots[index]!;
        current.assertCurrent();
        if (
          current.source.agentId !== source.agentId ||
          current.source.path !== source.path ||
          current.capturedReadSource?.databaseIdentity !== expectedSource?.databaseIdentity ||
          current.capturedReadSource?.databaseBirthtime !== expectedSource?.databaseBirthtime
        ) {
          throw new Error("Prepared session lookup source changed");
        }
        read.result = ok(
          Object.fromEntries(current.entries.map(({ sessionKey, entry }) => [sessionKey, entry])),
        );
        read.readSource = current.source;
        read.capturedReadSource = current.capturedReadSource;
      }
      const target = plan.resolve();
      assertCurrent();
      if (
        target.agentId !== selectedSource.agentId ||
        target.canonicalKey !== selectedSource.canonicalKey ||
        target.storePath !== selectedSource.storePath ||
        !isDeepStrictEqual(target.readSource, selectedSource.readSource)
      ) {
        throw new Error("Prepared session lookup selected another source");
      }
      return target;
    } finally {
      for (const { read } of reads) {
        read.result = undefined;
        read.readSource = undefined;
        read.capturedReadSource = undefined;
      }
    }
  };
  assertCurrent();
  for (const { read } of reads) {
    read.result = undefined;
    read.readSource = undefined;
    read.capturedReadSource = undefined;
  }
  return {
    target: initialTarget,
    readPlan: {
      reads: reads.map(({ input }) => input),
      assertCurrent,
      selectPrepared(current) {
        return select(
          current.map((read) => ({
            entries: read.result.entries,
            source: { agentId: read.database.agentId, path: read.database.path },
            capturedReadSource: read.result.source,
            assertCurrent: read.assertCurrent,
          })),
        );
      },
    },
  };
}

/** Entry preparation shares the Gateway's alias, discovery, and reader owners. */
export async function loadGatewaySessionEntryReadOnlyInWorker(
  params: Parameters<typeof resolveGatewaySessionStoreTargetInWorker>[0] & {
    excludeInternalEffects?: boolean;
    includeStoreChildEntries?: boolean;
  },
) {
  const { excludeInternalEffects, ...lookup } = params;
  const target = await resolveGatewaySessionStoreTargetInWorker({
    ...lookup,
    projection: params.projection ?? "full",
  });
  params.assertActive?.();
  if (excludeInternalEffects) {
    omitInternalSessionEffectsEntries(target.store, target.storeKeys);
  }
  const match = findCanonicalStoreMatch(target.store, target.storeKeys);
  return {
    ...target,
    cfg: params.cfg,
    entry: match?.entry,
    legacyKey: match?.key !== target.canonicalKey ? match?.key : undefined,
  };
}

/** Retain the original lookup domain for a later synchronous admission predicate. */
export async function prepareGatewaySessionEntryReadOnlyInWorker(
  params: Parameters<typeof loadGatewaySessionEntryReadOnlyInWorker>[0],
  onSelected?: (target: GatewaySessionStoreTargetWithStore) => void,
): Promise<{
  loaded: Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>;
  readPlan?: GatewaySessionEntryReadPlan;
}> {
  const { excludeInternalEffects, ...lookup } = params;
  const { target, readPlan } = await prepareGatewaySessionStoreReadInWorker(
    {
      ...lookup,
      projection: params.projection ?? "full",
    },
    true,
    onSelected,
  );
  params.assertActive?.();
  const select = (current: GatewaySessionStoreTargetWithStore) => {
    if (excludeInternalEffects) {
      omitInternalSessionEffectsEntries(current.store, current.storeKeys);
    }
    return findCanonicalStoreMatch(current.store, current.storeKeys);
  };
  await includeDirectChildEntriesInWorker(target, params);
  params.assertActive?.();
  const match = select(target);
  return {
    loaded: {
      ...target,
      cfg: params.cfg,
      entry: match?.entry,
      legacyKey: match?.key !== target.canonicalKey ? match?.key : undefined,
    },
    readPlan: readPlan && {
      reads: readPlan.reads,
      assertCurrent: readPlan.assertCurrent,
      selectPrepared: (reads) => select(readPlan.selectPrepared(reads))?.entry,
    },
  };
}
