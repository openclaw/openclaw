import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  inspectAcpSessionClaimsForDoctor,
  updateAcpSessionIdentityForDoctor,
} from "../acp/runtime/session-meta-doctor.js";
import {
  createChannelIngressQueue,
  listChannelIngressQueueAccountIdsReadOnly,
  type ChannelIngressQueue,
} from "../channels/message/ingress-queue.js";
import { importLegacyChannelIngressEntries } from "../channels/message/ingress-queue.migration.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionIdentityEvidenceBatch } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  resolveExistingAgentSessionStoreTargetsReadOnlyResult,
  type SessionStoreTargetsReadCache,
} from "../config/sessions/targets-read-availability.worker.js";
import { dedupeSessionStoreTargetsBySqliteTarget } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWriteTransaction } from "../plugin-state/plugin-state-store.database.js";
import {
  MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES,
  createPluginStateKeyedStore,
  getPluginStateCapacity,
  importPluginStateEntriesForDoctor,
  pluginStateDeleteEntriesIfUnchanged,
  pluginStateDoctorEntriesInKeyRange,
  type OpenKeyedStoreOptions,
} from "../plugin-state/plugin-state-store.js";
import { getPluginStateKysely } from "../plugin-state/plugin-state-store.kernel.js";
import {
  observedPluginStateRow,
  type PluginDoctorRawStateEntry,
} from "../plugin-state/plugin-state-store.sqlite.js";
import {
  prepareRegisterParams,
  validateNamespace,
} from "../plugin-state/plugin-state-store.validation.js";
import type {
  PluginDoctorChannelIngressQueueAccess,
  PluginDoctorChannelIngressQueueInspection,
  PluginDoctorStateMigrationContext,
} from "../plugins/doctor-contract-module.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  readDeferredPluginSessionImport,
  resolveVerifiedSessionSource,
} from "./deferred-plugin-session-sources.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "./sqlite-worker-identity.js";
import { readSessionStoreJson5 } from "./state-migrations.fs.js";
import type { PluginDoctorRepairAuthority } from "./state-migrations.types.js";

type SessionEvidenceResult = Awaited<
  ReturnType<NonNullable<PluginDoctorStateMigrationContext["readSessionIdentityEvidenceBatch"]>>
>[number];
type DoctorSessionStoreTarget = { agentId: string; storePath: string };

type SessionSourceEvidence = { imported: boolean; sessionIds: ReadonlySet<string> };

function hasUnimportedSessionIdentity(params: {
  agentId: string;
  sessionId: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  cache: Map<string, SessionSourceEvidence>;
}): boolean {
  const agentId = normalizeAgentId(params.agentId);
  const configuredStore = resolveSessionStorePathCore(params.config.session?.store, {
    agentId,
    env: params.env,
  });
  const defaultStore = resolveSessionStorePathCore(undefined, { agentId, env: params.env });
  const sources = new Set([configuredStore, defaultStore]);
  let importedIdentity = false;
  let unimportedIdentity = false;
  for (const storePath of sources) {
    if (storePath.endsWith(".sqlite")) {
      continue;
    }
    const key = `${agentId}\0${storePath}`;
    let sourceEvidence = params.cache.get(key);
    if (sourceEvidence === undefined) {
      const before = fs.statSync(storePath, { throwIfNoEntry: false, bigint: true });
      sourceEvidence = { imported: false, sessionIds: new Set() };
      if (before) {
        const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
          agentId,
          env: params.env,
        }).path;
        const receipt = readDeferredPluginSessionImport({
          cfg: params.config,
          target: {
            agentId,
            storePath,
          },
          sqlitePath,
          env: params.env,
          purpose: "canonical",
        });
        if (receipt) {
          const index = receipt.sources.find((source) => source.path === path.resolve(storePath));
          if (
            !index ||
            !resolveVerifiedSessionSource(index, { agentId, storePath, sqlitePath }, params.env)
          ) {
            throw new Error(`Retained plugin session index requires Doctor repair: ${storePath}`);
          }
        }
        const parsed = readSessionStoreJson5(storePath);
        const after = fs.statSync(storePath, { throwIfNoEntry: false, bigint: true });
        if (
          !parsed.ok ||
          !after ||
          (["dev", "ino", "mtimeNs", "ctimeNs", "size"] as const).some(
            (field) => before[field] !== after[field],
          )
        ) {
          throw new Error(
            `Legacy session source could not be verified while reading identity evidence: ${storePath}`,
          );
        }
        sourceEvidence = {
          imported: receipt !== undefined,
          sessionIds: new Set(
            Object.values(parsed.store).flatMap((entry) =>
              isRecord(entry) && typeof entry.sessionId === "string"
                ? [entry.sessionId.trim()]
                : [],
            ),
          ),
        };
      }
      params.cache.set(key, sourceEvidence);
    }
    if (sourceEvidence.sessionIds.has(params.sessionId)) {
      importedIdentity ||= sourceEvidence.imported;
      unimportedIdentity ||= !sourceEvidence.imported;
    }
  }
  return !importedIdentity && unimportedIdentity;
}

function resolveDoctorSessionIdentityEvidence(params: {
  cache: SessionStoreTargetsReadCache;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  requests: readonly { agentId: string; sessionId: string }[];
  targetsByAgent: Map<string, readonly DoctorSessionStoreTarget[] | null>;
}): SessionEvidenceResult[] {
  if (params.requests.length > MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES) {
    throw new Error("Plugin doctor session evidence batch exceeds the maximum size.");
  }
  const probes: Array<
    DoctorSessionStoreTarget & { env: NodeJS.ProcessEnv; index: number; sessionId: string }
  > = [];
  for (const [index, request] of params.requests.entries()) {
    const agentId = normalizeAgentId(request.agentId);
    let targets = params.targetsByAgent.get(agentId);
    if (targets === undefined) {
      try {
        const resolved = resolveExistingAgentSessionStoreTargetsReadOnlyResult(
          params.config,
          agentId,
          {
            cache: params.cache,
            env: params.env,
          },
        );
        if (!resolved.available) {
          targets = null;
        } else {
          const candidates = resolved.targets.length
            ? resolved.targets
            : [
                {
                  agentId,
                  storePath: resolveSessionStorePathCore(params.config.session?.store, {
                    agentId,
                    env: params.env,
                  }),
                },
              ];
          targets = dedupeSessionStoreTargetsBySqliteTarget(candidates, {
            defaultAgentId: agentId,
            env: params.env,
          });
        }
      } catch {
        targets = null;
      }
      params.targetsByAgent.set(agentId, targets);
    }
    for (const target of targets ?? []) {
      probes.push({ ...target, env: params.env, index, sessionId: request.sessionId });
    }
  }
  const evidence = readSessionIdentityEvidenceBatch(probes);
  const sourceImports = new Map<string, SessionSourceEvidence>();
  const observedByRequest: (typeof evidence)[] = params.requests.map(() => []);
  for (const [position, observed] of evidence.entries()) {
    observedByRequest[probes[position]!.index]!.push(observed);
  }
  return params.requests.map((request, index): SessionEvidenceResult => {
    const observed = observedByRequest[index]!;
    const current = observed.filter((entry) => entry.status === "current");
    if (
      !observed.length ||
      observed.some((entry) => entry.status === "unknown") ||
      current.length > 1
    ) {
      return { ...request, state: "unknown" };
    }
    const unimported =
      current.length === 0 &&
      hasUnimportedSessionIdentity({
        agentId: request.agentId,
        sessionId: request.sessionId,
        config: params.config,
        env: params.env,
        cache: sourceImports,
      });
    return current[0]
      ? { ...request, state: "current", sessionKey: current[0].sessionKey }
      : { ...request, state: unimported ? "unknown" : "absent" };
  });
}

/** Build a genuinely read-only object rather than a narrowed view of the queue.
 *  A `Pick<...>` return type would still hand the caller every mutating method at
 *  runtime, so the boundary has to exist in the value, not only in the type. */
function projectIngressQueueForInspection<TPayload, TMetadata>(
  queue: ChannelIngressQueue<TPayload, TMetadata>,
): PluginDoctorChannelIngressQueueInspection<TPayload, TMetadata> {
  const listFailed = queue.listFailed?.bind(queue);
  const projection: PluginDoctorChannelIngressQueueInspection<TPayload, TMetadata> = {
    listPending: (...args) => queue.listPending(...args),
    listClaims: () => queue.listClaims(),
  };
  if (listFailed) {
    projection.listFailed = (...args) => listFailed(...args);
  }
  return projection;
}

function buildChannelIngressQueueAccess(
  options: PluginDoctorChannelIngressAccessOptions,
): PluginDoctorChannelIngressQueueAccess[] {
  const { channelIds, stateDir, mutation } = options;
  return channelIds.map((channelId) => {
    const open = <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
      openOptions: { accountId?: string } | undefined,
      access: "read-write" | "read-only",
      assertCurrent?: () => void,
    ) =>
      createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>(
        {
          channelId,
          ...(openOptions?.accountId === undefined ? {} : { accountId: openOptions.accountId }),
          stateDir,
          access,
        },
        assertCurrent,
      );
    const access: PluginDoctorChannelIngressQueueAccess = {
      channelId,
      // Detection runs before exclusive ownership, so it reads through the
      // non-creating read-only opener as well as a listing-only projection.
      openChannelIngressQueueForInspection: (openOptions) =>
        projectIngressQueueForInspection(open(openOptions, "read-only")),
      // Discovery runs before the inspection facade is even opened, so it takes the
      // same non-creating path rather than the write-capable opener.
      listChannelIngressQueueAccountIds: () =>
        listChannelIngressQueueAccountIdsReadOnly({ channelId, stateDir }),
    };
    if (mutation) {
      const assertCurrent = () => mutation.assertCurrent();
      access.assertCurrent = assertCurrent;
      access.importLegacyEntries = (input) =>
        importLegacyChannelIngressEntries({ ...input, channelId, stateDir, assertCurrent });
      access.openChannelIngressQueue = (openOptions) =>
        open(openOptions, "read-write", assertCurrent);
    }
    return access;
  });
}

/** Host-fixed ingress access for one migration phase. `mutation` is supplied only by
 *  the locked repair section; without it the plugin sees inspection-only queues. */
export type PluginDoctorChannelIngressAccessOptions = {
  channelIds: readonly string[];
  stateDir: string;
  mutation?: { assertCurrent(): void };
};

/** Backed-up same-schema repair; source observations and replacement values freeze before yielding. */
async function repairPluginStateEntriesForDoctor(params: {
  pluginId: string;
  namespace: string;
  replacements: readonly { entry: PluginDoctorRawStateEntry; value: unknown }[];
  authority: PluginDoctorRepairAuthority;
  env: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const { pluginId, authority } = params;
  const env = { ...params.env };
  const namespace = validateNamespace(params.namespace);
  const rows = structuredClone(params.replacements).map(({ entry, value }) => {
    const { key, valueJson } = prepareRegisterParams(entry.key, value);
    return { entry, key, valueJson };
  });
  if (
    rows.length > MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES ||
    new Set(rows.map((row) => row.key)).size !== rows.length ||
    rows.some(({ key, entry }) => key !== entry.key)
  ) {
    throw new Error("Plugin Doctor repair requires a bounded batch of distinct rows.");
  }
  if (!rows.length) {
    return { changes: [], warnings: [] };
  }
  authority.assertCurrent();
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const identity = readDatabasePathIdentitySync(databasePath);
  const assertCurrent = () => {
    authority.assertCurrent();
    assertExistingDatabaseIdentity(databasePath, identity.key, identity.birthtime);
  };
  const validate = (db: DatabaseSync) => {
    for (const { entry } of rows) {
      const query = getPluginStateKysely(db)
        .selectFrom("plugin_state_entries")
        .select("entry_key")
        .where((eb) => observedPluginStateRow(eb, { pluginId, namespace }, entry));
      if (!executeSqliteQuerySync(db, query).rows.length) {
        throw new Error(
          "Plugin state changed during Doctor repair; inspect again before retrying.",
        );
      }
    }
  };
  const { backupDoctorSqliteDatabases } = await import("../commands/doctor-migration-backup.js");
  assertCurrent();
  const backup = await backupDoctorSqliteDatabases({
    env,
    pendingDatabasePaths: [databasePath],
    databasePaths: [databasePath],
    authority: { assertCurrent },
    repair: {
      key: createHash("sha256")
        .update(JSON.stringify([pluginId, namespace, rows]))
        .digest("hex"),
      validate,
    },
  });
  assertCurrent();
  runWriteTransaction(
    "register",
    ({ db }) => {
      assertCurrent();
      authority.assertOwnedInTransaction(db);
      validate(db);
      for (const { key, valueJson } of rows) {
        executeSqliteQuerySync(
          db,
          getPluginStateKysely(db)
            .updateTable("plugin_state_entries")
            .set({ value_json: valueJson })
            .where("plugin_id", "=", pluginId)
            .where("namespace", "=", namespace)
            .where("entry_key", "=", key),
        );
      }
      authority.assertOwnedInTransaction(db);
    },
    { env },
  );
  return backup;
}

export function createPluginDoctorStateMigrationContext(params: {
  pluginId: string;
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
  repairAuthority?: PluginDoctorRepairAuthority;
  trustedForDurableStores?: boolean;
  channelIngress?: PluginDoctorChannelIngressAccessOptions;
}): PluginDoctorStateMigrationContext {
  const { pluginId, env } = params;
  const cache: SessionStoreTargetsReadCache = new Map();
  const targetsByAgent = new Map<string, readonly DoctorSessionStoreTarget[] | null>();
  const context: PluginDoctorStateMigrationContext = {
    inspectAcpSessionClaims: async () => {
      params.repairAuthority?.assertCurrent();
      const evidence = await inspectAcpSessionClaimsForDoctor(params);
      params.repairAuthority?.assertCurrent();
      return evidence;
    },
    getPluginStateCapacity: () => getPluginStateCapacity(pluginId, env),
    importPluginStateEntries(options, entries) {
      importPluginStateEntriesForDoctor(pluginId, { ...options, env: options.env ?? env }, entries);
    },
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStore<T>(pluginId, { ...options, env: options.env ?? env });
    },
    readPluginStateEntriesInKeyRange(namespace, range) {
      params.repairAuthority?.assertCurrent();
      return pluginStateDoctorEntriesInKeyRange({
        pluginId,
        namespace,
        ...range,
        env,
      });
    },
    async readSessionIdentityEvidenceBatch(requests) {
      params.repairAuthority?.assertCurrent();
      const evidence = resolveDoctorSessionIdentityEvidence({
        cache,
        config: params.config,
        env,
        requests,
        targetsByAgent,
      });
      params.repairAuthority?.assertCurrent();
      return evidence;
    },
  };
  if (params.channelIngress) {
    context.channelIngressQueues = buildChannelIngressQueueAccess(params.channelIngress);
  }
  if (params.trustedForDurableStores) {
    context.inspectCronJobs = async () => {
      params.repairAuthority?.assertCurrent();
      const { inspectCronJobsForDoctor } = await import("../commands/doctor/cron/store-repair.js");
      params.repairAuthority?.assertCurrent();
      const inventory = await inspectCronJobsForDoctor(params);
      params.repairAuthority?.assertCurrent();
      return inventory;
    };
    if (params.repairAuthority) {
      const authority = params.repairAuthority;
      context.repairCronJobs = async (inventory, changes) => {
        authority.assertCurrent();
        const { repairCronJobsForDoctor } = await import("../commands/doctor/cron/store-repair.js");
        authority.assertCurrent();
        return repairCronJobsForDoctor(params, authority, inventory, changes);
      };
    }
  }
  if (params.repairAuthority) {
    const authority = params.repairAuthority;
    context.repairPluginStateEntries = (namespace, replacements) =>
      repairPluginStateEntriesForDoctor({ pluginId, env, namespace, replacements, authority });
    context.updateAcpSessionIdentity = (input) =>
      updateAcpSessionIdentityForDoctor(params, authority, input);
    context.deletePluginStateEntriesIfUnchanged = (namespace, entries) => {
      authority.assertCurrent();
      return pluginStateDeleteEntriesIfUnchanged({
        pluginId,
        namespace,
        entries,
        env,
        assertOwnedInTransaction: (database) => authority.assertOwnedInTransaction(database),
      });
    };
  }
  return context;
}
