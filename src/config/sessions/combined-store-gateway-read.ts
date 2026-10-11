import nodePath from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { prepareAgentDatabaseDeletionSnapshotRead } from "../../state/agent-deletion-journal.read.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  applyGatewaySessionStoreAdmission,
  listMemorySessionStoreTargets,
  mergeCombinedSessionStore,
  type GatewayCombinedSessionStore,
  type GatewaySessionStoreOptions,
} from "./combined-store-gateway.js";
import { storeTargetKey } from "./combined-store-paths.js";
import type { CombinedSessionStoreTopologyResult } from "./combined-store.types.js";
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
import { listConfiguredSessionStoreAgentIds } from "./targets.js";

type CombinedReadOptions = Omit<GatewaySessionStoreOptions, "loadEntries" | "onStoreLoaded">;

export async function loadCombinedSessionStoreForGatewayCoreAsync(
  cfg: OpenClawConfig,
  opts: CombinedReadOptions = {},
): Promise<GatewayCombinedSessionStore> {
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
  const inventory = prepareSessionStoreTargetInventory(
    cfg,
    listConfiguredSessionStoreAgentIds(cfg),
    env,
    "recovery",
  );
  return loadCombinedSessionStore(inventory, options);
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
    snapshot: (await prepareAgentDatabaseDeletionSnapshotRead({ env }, "runtime").read()).snapshot,
  };
  const candidates = [
    ...inventory.candidates,
    ...(discovery.snapshot?.registeredAgentDatabases ?? []).flatMap(({ path }) =>
      captureSessionStoreReadCandidates(path),
    ),
  ];
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
      // Read memory owners once, when the complete listing is assembled.
      const readOptions = {
        ...options,
        discovery: { env, snapshot: options.discovery?.snapshot },
      };
      return mergeCombinedSessionStore(config, readOptions, prepared, (target) =>
        expectDefined(entries.get(storeTargetKey(target)), "prepared session entries"),
      );
    },
  );
}
