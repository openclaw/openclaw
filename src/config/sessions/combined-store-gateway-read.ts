import nodePath from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveSessionParentSessionKey } from "../../channels/plugins/session-conversation.js";
import { resolveStoredSessionKeyForAgentStore } from "../../gateway/session-store-key.js";
import { createGatewaySessionLineageReaderAsync } from "../../gateway/session-utils-store-lineage.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { readWithSessionStoreTopology } from "../../sessions/session-row-changes.js";
import { prepareAgentDatabaseDeletionSnapshotRead } from "../../state/agent-deletion-journal.read.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { captureRuntimeConfig } from "../runtime-source-projection.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  applyGatewaySessionStoreAdmission,
  listMemorySessionStoreTargets,
  mergeCombinedSessionStore,
  type GatewayCombinedSessionStore,
  type GatewaySessionStoreOptions,
} from "./combined-store-gateway.js";
import type { GatewaySessionLineageReader } from "./combined-store-model-sources.js";
import { createGatewayRetainedStoreMatcher, storeTargetKey } from "./combined-store-paths.js";
import type {
  CombinedSessionStoreTopologyResult,
  GatewaySessionStoreDiscovery,
  PreparedCombinedSessionStore,
} from "./combined-store.types.js";
import { captureMemoryExactSessionReader } from "./session-accessor.memory-exact-read.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import {
  captureSessionStoreReadCandidates,
  prepareSessionStoreTargetInventory,
} from "./session-store-target-inventory.js";
import {
  targetDiscoveryLane,
  withSessionHistoryWorkerReadCandidates,
} from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabases } from "./session-transcript-worker-runtime.js";
import { listConfiguredSessionStoreAgentIds, type SessionStoreTarget } from "./targets.js";
import type { SessionEntry } from "./types.js";

type CombinedReadOptions = Omit<GatewaySessionStoreOptions, "loadEntries" | "onStoreLoaded">;

export async function loadCombinedSessionStoreForGatewayCoreAsync(
  cfg: OpenClawConfig,
  opts: CombinedReadOptions = {},
): Promise<GatewayCombinedSessionStore> {
  const config = captureRuntimeConfig(cfg);
  const selected =
    opts.includeIncognito === false
      ? undefined
      : captureSessionActorStorageOwner({ env: opts.discovery?.env });
  const env = cloneEnvWithPlatformSemantics(
    opts.discovery?.env ??
      (selected
        ? { ...process.env, OPENCLAW_STATE_DIR: nodePath.resolve(selected.path, "../../../..") }
        : process.env),
  );
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = { ...opts, ...(opts.discovery && { discovery: { ...opts.discovery, env } }) };
  const read = async () => {
    const inventory = prepareSessionStoreTargetInventory(
      config,
      listConfiguredSessionStoreAgentIds(config),
      env,
      "recovery",
    );
    const discovery = options.discovery ?? {
      env,
      snapshot: (
        await prepareAgentDatabaseDeletionSnapshotRead({ env }, "runtime-discovery").read()
      ).snapshot,
    };
    return loadCombinedSessionStore(inventory, { ...options, discovery });
  };
  return options.discovery ? read() : readWithSessionStoreTopology(read);
}

/** Capture missing owners' lineage before synchronous display and model projection. */
export async function prepareCombinedSessionStoreLineage(
  cfg: OpenClawConfig,
  prepared: PreparedCombinedSessionStore,
  readEntries: (target: SessionStoreTarget) => SessionEntrySummary[],
  discovery?: GatewaySessionStoreDiscovery,
): Promise<
  GatewaySessionLineageReader & {
    readIncognitoEntries: (target: SessionStoreTarget) => SessionEntrySummary[];
  }
> {
  const incognitoEntries = new Map(
    prepared.targets.incognitoTargets.map((target) => [
      storeTargetKey(target),
      captureMemoryExactSessionReader(target)?.entries(prepared.projection) ?? [],
    ]),
  );
  const excluded = createGatewayRetainedStoreMatcher(cfg, discovery);
  const owners = new Set(prepared.targets.preparedAgentIds);
  const rows: Array<{ agentId: string; sessionKey: string; entry: SessionEntry }> = [];
  for (const { target, storeTarget } of prepared.reads) {
    const shared = prepared.targets.sharedStoreRowOwner;
    const rowAgentId =
      shared?.target.storePath === target.storePath && shared.target.agentId === target.agentId
        ? shared.agentId
        : target.agentId;
    owners.add(target.agentId);
    owners.add(storeTarget.agentId);
    owners.add(rowAgentId);
    for (const row of readEntries(storeTarget)) {
      const agentId = normalizeAgentId(parseAgentSessionKey(row.sessionKey)?.agentId ?? rowAgentId);
      if (excluded(storeTarget.storePath, agentId)) {
        continue;
      }
      owners.add(agentId);
      rows.push({ ...row, agentId });
    }
  }
  for (const target of prepared.targets.incognitoTargets) {
    for (const row of incognitoEntries.get(storeTargetKey(target)) ?? []) {
      rows.push({ ...row, agentId: target.agentId });
    }
  }
  const identity = (agentId: string, key: string) => JSON.stringify([agentId, key]);
  const parents = new Map<
    string,
    { agentId: string; parentKey: string; owner: string; storedKey: string }
  >();
  for (const { agentId, sessionKey, entry } of rows) {
    for (const parent of [
      entry.parentSessionKey,
      entry.spawnedBy,
      resolveSessionParentSessionKey(sessionKey),
    ]) {
      const parentKey = parent?.trim();
      const parsed = parentKey ? parseAgentSessionKey(parentKey) : undefined;
      if (!parentKey || !parsed) {
        continue;
      }
      const owner = normalizeAgentId(parsed.agentId);
      if (
        !owners.has(owner) &&
        !excluded(resolveOpenClawAgentSqlitePath({ agentId: owner, env: discovery?.env }), owner)
      ) {
        parents.set(identity(agentId, parentKey), {
          agentId,
          parentKey,
          owner,
          storedKey: resolveStoredSessionKeyForAgentStore({
            cfg,
            agentId: owner,
            sessionKey: parentKey,
            preserveQualifiedAddress: true,
          }),
        });
      }
    }
  }
  const reader = createGatewaySessionLineageReaderAsync(cfg);
  const stored = new Map<string, Promise<SessionEntry | undefined>>();
  for (const { owner, storedKey } of parents.values()) {
    const key = identity(owner, storedKey);
    if (!stored.has(key)) {
      stored.set(key, reader.readStored(owner, storedKey));
    }
  }
  const entries = new Map(
    await Promise.all([...stored].map(async ([key, row]) => [key, await row] as const)),
  );
  const aliases = new Map(
    await Promise.all(
      [...parents].map(
        async ([key, parent]) =>
          [
            key,
            entries.get(identity(parent.owner, parent.storedKey)) === undefined
              ? await reader.readAlias(parent.parentKey, parent.agentId)
              : undefined,
          ] as const,
      ),
    ),
  );
  return {
    readStored: (agentId, key) => entries.get(identity(agentId, key)),
    readAlias: (key, agentId) => aliases.get(identity(agentId, key)),
    readIncognitoEntries: (target) => incognitoEntries.get(storeTargetKey(target)) ?? [],
  };
}

/** Prepare durable topology in one worker request before a synchronous projection publication. */
export async function prepareCombinedSessionStoreForGatewayAsync(
  cfg: OpenClawConfig,
  options: CombinedReadOptions,
  scopeAgentIds?: readonly string[],
): Promise<CombinedSessionStoreTopologyResult> {
  const env = options.discovery?.env ?? process.env;
  const inventory = prepareSessionStoreTargetInventory(
    cfg,
    listConfiguredSessionStoreAgentIds(cfg),
    env,
    "recovery",
  );
  return readCombinedSessionStoreTopology(inventory, options, scopeAgentIds);
}

async function readCombinedSessionStoreTopology(
  inventory: ReturnType<typeof prepareSessionStoreTargetInventory>,
  options: CombinedReadOptions,
  scopeAgentIds?: readonly string[],
): Promise<CombinedSessionStoreTopologyResult> {
  const { config, env } = inventory;
  const discovery = options.discovery ?? {
    env,
    snapshot: (await prepareAgentDatabaseDeletionSnapshotRead({ env }, "runtime-discovery").read())
      .snapshot,
  };
  // Discovery leaves deleting stores before their resource owner starts closing readers.
  const excluded = createGatewayRetainedStoreMatcher(config, discovery);
  const candidates = [
    ...inventory.candidates,
    ...(discovery.snapshot?.registeredAgentDatabases ?? []).flatMap(({ path }) =>
      captureSessionStoreReadCandidates(path),
    ),
  ].filter(
    (candidate) =>
      // Existing siblings are captured exactly; family custody would also retain excluded files.
      candidate.scope !== "sibling-family" &&
      !excluded(candidate.path) &&
      !excluded(candidate.physicalPath),
  );
  return withSessionHistoryWorkerReadCandidates(
    candidates,
    async (owner) => {
      const result = await owner.readCombinedTopology({
        config,
        options: { ...options, includeIncognito: false, discovery },
        scopeAgentIds,
      });
      result.prepared.targets.incognitoTargets =
        options.includeIncognito === false
          ? []
          : listMemorySessionStoreTargets(env).filter(
              (target) =>
                !result.prepared.targets.requestedAgentId ||
                target.agentId === result.prepared.targets.requestedAgentId,
            );
      result.prepared.targets = applyGatewaySessionStoreAdmission(
        config,
        { ...options, discovery },
        result.prepared.targets,
      );
      result.prepared.reads = result.prepared.targets.durableTargets.map((target) => ({
        target,
        storeTarget: expectDefined(
          result.prepared.targets.physicalTargets.get(storeTargetKey(target)),
          "physical store",
        ),
      }));
      return result;
    },
    targetDiscoveryLane,
  );
}

/** Descriptive listings consume one captured topology; later changes belong to the next read. */
async function loadCombinedSessionStore(
  inventory: ReturnType<typeof prepareSessionStoreTargetInventory>,
  options: CombinedReadOptions,
): Promise<GatewayCombinedSessionStore> {
  const { config, env } = inventory;
  const { prepared } = await readCombinedSessionStoreTopology(inventory, options);
  // Windows environment proxies cannot cross the worker boundary.
  const transferEnv = { ...env, OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR };
  return withSessionHistoryWorkerDatabases(
    prepared.reads.map(({ storeTarget }) => ({
      agentId: storeTarget.agentId,
      path: storeTarget.storePath,
      env,
    })),
    async (owners) => {
      const rows = await Promise.all(
        prepared.reads.map(async ({ storeTarget }, index) => {
          const source = expectDefined(owners[index], "retained session store");
          const { entries } = await source.readEntries({
            ...storeTarget,
            env: transferEnv,
            projection: prepared.projection,
            clone: false,
          });
          return [storeTargetKey(storeTarget), entries] as const;
        }),
      );
      const entries = new Map(rows);
      const readEntries = (target: SessionStoreTarget) =>
        expectDefined(entries.get(storeTargetKey(target)), "prepared session entries");
      const lineage = await prepareCombinedSessionStoreLineage(
        config,
        prepared,
        readEntries,
        options.discovery,
      );
      const readOptions = {
        ...options,
        discovery: { env, snapshot: options.discovery?.snapshot },
      };
      return mergeCombinedSessionStore(
        config,
        readOptions,
        prepared,
        readEntries,
        lineage,
        lineage.readIncognitoEntries,
      );
    },
  );
}
