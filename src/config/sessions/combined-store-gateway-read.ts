import { expectDefined } from "@openclaw/normalization-core";
import { prepareAgentDatabaseDeletionSnapshotRead } from "../../state/agent-deletion-journal.read.js";
import { listOpenIncognitoAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  applyGatewaySessionStoreAdmission,
  mergeCombinedSessionStore,
  type GatewayCombinedSessionStore,
  type GatewaySessionStoreOptions,
} from "./combined-store-gateway.js";
import { storeTargetKey } from "./combined-store-paths.js";
import type { CombinedSessionStoreTopologyResult } from "./combined-store.types.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";
import {
  captureIncognitoSessionTopology,
  withIncognitoSessionStoreEntries,
} from "./session-incognito-binding.js";
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
  const topology = opts.includeIncognito === false ? undefined : captureIncognitoSessionTopology();
  const env = cloneEnvWithPlatformSemantics(opts.discovery?.env ?? topology?.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  if (topology && env.OPENCLAW_STATE_DIR !== resolveStateDir(topology.env)) {
    throw new Error("Combined discovery belongs to another incognito state root");
  }
  const options = { ...opts, ...(opts.discovery && { discovery: { ...opts.discovery, env } }) };
  const inventory = prepareSessionStoreTargetInventory(
    cfg,
    listConfiguredSessionStoreAgentIds(cfg),
    env,
    "recovery",
  );
  const nativeIncognitoTargets =
    !topology && opts.includeIncognito !== false ? listOpenIncognitoAgentDatabases() : [];
  const read = (stores?: readonly IncognitoStore[]) =>
    loadCombinedSessionStore(inventory, options, stores, nativeIncognitoTargets);
  return topology ? withIncognitoSessionStoreEntries(read, options.projection ?? "list") : read();
}

type IncognitoStore = {
  agentId: string;
  storePath: string;
  entries: SessionEntrySummary[];
};

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
      result.prepared.targets = applyGatewaySessionStoreAdmission(
        config,
        options,
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
  incognitoStores?: readonly IncognitoStore[],
  nativeIncognitoTargets: ReturnType<typeof listOpenIncognitoAgentDatabases> = [],
): Promise<GatewayCombinedSessionStore> {
  const { config, env } = inventory;
  const { prepared } = await readCombinedSessionStoreTopology(inventory, options);
  // Unbound private stores remain with their existing process-local owner.
  prepared.targets.incognitoTargets = (incognitoStores ?? nativeIncognitoTargets).filter(
    (store) =>
      !prepared.targets.requestedAgentId || store.agentId === prepared.targets.requestedAgentId,
  );
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
      return mergeCombinedSessionStore(
        config,
        options,
        prepared,
        (target) => expectDefined(entries.get(storeTargetKey(target)), "prepared session entries"),
        incognitoStores &&
          ((target) =>
            expectDefined(
              incognitoStores.find((store) => store.storePath === target.storePath),
              "captured actor",
            ).entries),
      );
    },
  );
}
