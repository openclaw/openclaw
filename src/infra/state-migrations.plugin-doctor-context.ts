import fs from "node:fs";
import path from "node:path";
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
import { resolveStateDir } from "../config/paths.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionIdentityEvidenceBatch } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  resolveExistingAgentSessionStoreTargetsReadOnlyResult,
  type SessionStoreTargetsReadCache,
} from "../config/sessions/targets-read-availability.js";
import { dedupeSessionStoreTargetsBySqliteTarget } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES,
  createPluginStateKeyedStore,
  getPluginStateCapacity,
  importPluginStateEntriesForDoctor,
  pluginStateDeleteEntriesIfUnchanged,
  pluginStateDoctorEntriesInKeyRange,
  type OpenKeyedStoreOptions,
} from "../plugin-state/plugin-state-store.js";
import type {
  PluginDoctorChannelIngressQueueAccess,
  PluginDoctorChannelIngressQueueInspection,
  PluginDoctorStateMigrationContext,
} from "../plugins/doctor-contract-module.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  readDeferredPluginSessionImport,
  resolveVerifiedSessionSource,
} from "./deferred-plugin-session-sources.js";
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
  const legacyRootStore = path.join(resolveStateDir(params.env), "sessions", "sessions.json");
  const sources = new Map([
    [configuredStore, configuredStore],
    [defaultStore, defaultStore],
    [legacyRootStore, configuredStore],
  ]);
  let importedIdentity = false;
  let unimportedIdentity = false;
  for (const [storePath, destination] of sources) {
    if (storePath.endsWith(".sqlite")) {
      continue;
    }
    const key = `${agentId}\0${storePath}\0${destination}`;
    let sourceEvidence = params.cache.get(key);
    if (sourceEvidence === undefined) {
      const before = fs.statSync(storePath, { throwIfNoEntry: false, bigint: true });
      sourceEvidence = { imported: false, sessionIds: new Set() };
      if (before) {
        const sqlitePath = resolveSqliteTargetFromSessionStorePath(destination, {
          agentId,
          env: params.env,
        }).path;
        const receipt = readDeferredPluginSessionImport({
          cfg: params.config,
          target: {
            agentId,
            storePath,
            ...(storePath === legacyRootStore ? { sqlitePath } : {}),
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
      const { inspectCronJobsForDoctor } = await import("../cron/store/doctor.js");
      params.repairAuthority?.assertCurrent();
      const inventory = await inspectCronJobsForDoctor(params);
      params.repairAuthority?.assertCurrent();
      return inventory;
    };
    if (params.repairAuthority) {
      const authority = params.repairAuthority;
      context.repairCronJobs = async (inventory, changes) => {
        authority.assertCurrent();
        const { repairCronJobsForDoctor } = await import("../cron/store/doctor.js");
        authority.assertCurrent();
        return repairCronJobsForDoctor(params, authority, inventory, changes);
      };
    }
  }
  if (params.repairAuthority) {
    const authority = params.repairAuthority;
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
