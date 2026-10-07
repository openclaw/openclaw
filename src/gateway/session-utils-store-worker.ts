import { isDeepStrictEqual } from "node:util";
import { ok } from "@openclaw/normalization-core/result";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import {
  assertCapturedSessionEntryReadSource,
  loadExactSessionEntryCandidates,
} from "../config/sessions/session-accessor.sqlite-exact-read.js";
import type { SessionEntryReadScope } from "../config/sessions/session-accessor.types.js";
import { withSessionEntriesFromStoresInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type {
  PreparedSessionEntryWorkerRead,
  SessionEntryWorkerRead,
} from "../config/sessions/session-entry-read-runtime.types.js";
import type {
  CapturedSessionEntryReadSource,
  SessionEntryReadSource,
} from "../config/sessions/session-entry-read-source.types.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "../config/sessions/session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "../config/sessions/session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "../config/sessions/session-store-target-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import type { GatewaySessionStoreDiscoveryCache } from "./session-utils-store-candidates.js";
import {
  prepareGatewaySessionStoreTargetReadOnly,
  prepareGatewaySessionStoreTargetReadPlan,
  resolveGatewaySessionStoreTargetWithStore,
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
  readLegacy: () => GatewaySessionStoreTargetWithStore;
  retainNative: () => {
    readCurrent: () => GatewaySessionStoreTargetWithStore;
    release: () => void;
  };
};

export type GatewaySessionEntryReadPlan = {
  reads: readonly SessionEntryWorkerRead[];
  assertCurrent: () => void;
  selectPrepared: (reads: readonly PreparedSessionEntryWorkerRead[]) => SessionEntry | undefined;
  readLegacy: () => SessionEntry | undefined;
  retainNative: () => { readCurrent: () => SessionEntry | undefined; release: () => void };
};

/** Acquire the ordered lookup's data while its discovery and physical readers remain current. */
export async function resolveGatewaySessionStoreTargetInWorker(params: {
  cfg: OpenClawConfig;
  key: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  assertActive?: () => void;
  projection?: SessionEntryReadScope["projection"];
}): Promise<GatewaySessionStoreTargetWithStore> {
  const prepared = await prepareGatewaySessionStoreReadInWorker(params);
  params.assertActive?.();
  return prepared.target;
}

async function prepareGatewaySessionStoreReadInWorker(
  params: Parameters<typeof resolveGatewaySessionStoreTargetInWorker>[0],
  retainPlan = false,
): Promise<{ target: GatewaySessionStoreTargetWithStore; readPlan?: GatewaySessionStoreReadPlan }> {
  params.assertActive?.();
  const { agentId, canonicalKey } = resolveSessionStoreIdentity({
    cfg: params.cfg,
    sessionKey: params.key,
    agentId: params.agentId,
  });
  // Ephemeral databases belong to the process and cannot be opened by a worker.
  if (isIncognitoSessionKey(canonicalKey)) {
    return {
      target: resolveGatewaySessionStoreTargetWithStore({
        ...params,
        agentId,
        readOnly: true,
        projection: params.projection ?? "list",
        exactRead: true,
      }),
    };
  }
  const parsedAgent = parseAgentSessionKey(params.key)?.agentId;
  const { candidates, ...inventory } = prepareSessionStoreTargetInventory(
    params.cfg,
    [agentId, ...(parsedAgent ? [parsedAgent] : [])],
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
  const prepared = await inventoryRead.withRead(async (sources, assertCurrent) => {
    const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
    for (const source of sources.agents) {
      if (!source.result.available && source.result.reason !== "database-missing") {
        throw new Error(`Session stores for agent ${source.agentId} are unavailable`);
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
      cfg: inventory.config,
      key: params.key,
      agentId,
      env: inventory.env,
      targetDiscoveryCache,
      projection: params.projection,
    };
    const prepareReads = async <T>(reads: readonly GatewaySessionStoreRead[], select: () => T) => {
      assertCurrent();
      return await withSessionEntriesFromStoresInWorker(
        reads.map((read) => ({
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
          for (const [index, read] of reads.entries()) {
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
      );
    };
    const selected = retainPlan
      ? await prepareGatewaySessionStoreTargetReadPlan(lookup, prepareReads)
      : {
          target: await prepareGatewaySessionStoreTargetReadOnly(lookup, prepareReads),
          plan: undefined,
        };
    assertCurrent();
    return selected;
  }, params.assertActive);
  params.assertActive?.();
  if (!prepared.plan) {
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
      readLegacy() {
        assertCurrent();
        return select(
          reads.map(({ input, source, expectedSource }) => {
            let capturedReadSource: CapturedSessionEntryReadSource | undefined;
            const entries = loadExactSessionEntryCandidates({
              readOnly: true,
              readSource: source,
              expectedSource,
              sessionKeys: input.sessionKeys ?? [],
              env: inventory.env,
              onReadSource: (current) => {
                capturedReadSource = current;
              },
            });
            return { entries, source, capturedReadSource, assertCurrent };
          }),
        );
      },
      retainNative() {
        assertCurrent();
        let active = true;
        const releases: Array<() => void> = [];
        const release = () => {
          if (!active) {
            return;
          }
          active = false;
          const errors: unknown[] = [];
          for (const close of releases.toReversed()) {
            try {
              close();
            } catch (error) {
              errors.push(error);
            }
          }
          throwSqliteLifecycleErrors(errors, "Prepared session lookup release failed");
        };
        try {
          // Acquire every physical source before a worker grant; final reads only
          // use retained handles and the original ordered selection owner.
          const retained = reads.map(({ input, source, expectedSource }) => {
            const opened = retainOpenClawAgentDatabaseReadOnly({
              agentId: source.agentId,
              path: source.path,
              env: inventory.env,
            });
            if (opened.found) {
              releases.push(opened.claim.release);
            } else if (expectedSource || opened.reason !== "database-missing") {
              throw new Error("Prepared session lookup source is unavailable");
            }
            const assertSourceCurrent = () => {
              assertCurrent();
              if (opened.found) {
                opened.claim.assertCurrent();
                if (expectedSource) {
                  assertCapturedSessionEntryReadSource(expectedSource, opened.database);
                }
              }
            };
            assertSourceCurrent();
            return () => {
              assertSourceCurrent();
              const physical = opened.found
                ? readOpenClawAgentDatabaseIdentity(opened.database)
                : undefined;
              const entries = opened.found
                ? (input.sessionKeys ?? []).flatMap((sessionKey) => {
                    const entry = readExactSessionEntryRow(
                      opened.database,
                      sessionKey,
                      "full",
                      "canonical",
                    )?.entry;
                    return entry ? [{ sessionKey, entry }] : [];
                  })
                : [];
              assertSourceCurrent();
              return {
                entries,
                source,
                capturedReadSource: physical && {
                  ...source,
                  databaseIdentity: physical.identity,
                  databaseBirthtime: physical.birthtime,
                },
                assertCurrent: assertSourceCurrent,
              };
            };
          });
          return {
            readCurrent() {
              if (!active) {
                throw new Error("Prepared session lookup retention is no longer active");
              }
              return select(retained.map((read) => read()));
            },
            release,
          };
        } catch (error) {
          release();
          throw error;
        }
      },
    },
  };
}

/** Entry preparation shares the Gateway's alias, discovery, and reader owners. */
export async function loadGatewaySessionEntryReadOnlyInWorker(
  params: Parameters<typeof resolveGatewaySessionStoreTargetInWorker>[0] & {
    excludeInternalEffects?: boolean;
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
  );
  params.assertActive?.();
  const select = (current: GatewaySessionStoreTargetWithStore) => {
    if (excludeInternalEffects) {
      omitInternalSessionEffectsEntries(current.store, current.storeKeys);
    }
    return findCanonicalStoreMatch(current.store, current.storeKeys);
  };
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
      readLegacy: () => select(readPlan.readLegacy())?.entry,
      retainNative() {
        const retained = readPlan.retainNative();
        return {
          readCurrent: () => select(retained.readCurrent())?.entry,
          release: retained.release,
        };
      },
    },
  };
}
