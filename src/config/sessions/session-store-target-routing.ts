import path from "node:path";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  listAgentDatabaseAdmissionRefusals,
  readAgentDatabaseAdmissionRefusal,
  readAgentDatabaseReadAdmissionRefusal,
} from "../../state/agent-database-admission.js";
import { isArtifactPreservingStateRead } from "../../state/artifact-preserving-state-reads.js";
import {
  cloneEnvWithPlatformSemantics,
  getPublishedConfigRuntimeEnvState,
} from "../config-env-vars.js";
import { getRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { captureRuntimeConfig } from "../runtime-source-projection.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentsDirFromSessionStorePath, resolveSessionStorePathCore } from "./paths.js";
import type { SessionStoreRegistryRead } from "./session-sqlite-target.js";
import { isPerAgentSessionStoreConfig } from "./session-store-config.js";
import type {
  CapturedSessionStorePaths,
  SessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import { listConfiguredSessionStoreAgentIds } from "./targets-configured-agents.js";

type InventoryEnvironment = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  serialized: NodeJS.ProcessEnv;
  configuredPaths?: CapturedSessionStorePaths;
};
let publishedInventoryEnvironment:
  | {
      config: OpenClawConfig;
      publication: ReturnType<typeof getPublishedConfigRuntimeEnvState>;
      captured: InventoryEnvironment;
    }
  | undefined;

/** Capture runtime routing without discovering physical store candidates. */
export function captureSessionStoreEnvironment(
  cfg: OpenClawConfig,
  inputEnv?: NodeJS.ProcessEnv,
): InventoryEnvironment {
  const config = captureRuntimeConfig(cfg);
  const publication =
    inputEnv === undefined && cfg === getRuntimeConfigSnapshot()
      ? getPublishedConfigRuntimeEnvState()
      : undefined;
  let environment =
    publication &&
    publishedInventoryEnvironment?.config === config &&
    publishedInventoryEnvironment.publication === publication
      ? publishedInventoryEnvironment.captured
      : undefined;
  if (!environment) {
    const env = cloneEnvWithPlatformSemantics(inputEnv ?? process.env);
    const stateDir = resolveStateDir(env);
    env.OPENCLAW_STATE_DIR = stateDir;
    // Windows path resolution needs the proxy; worker requests need a plain snapshot.
    environment = {
      config,
      env,
      stateDir,
      serialized: Object.freeze({ ...env, OPENCLAW_STATE_DIR: stateDir }),
    };
    if (publication) {
      // Config publication and env rollback both replace their existing owner-held identities.
      publishedInventoryEnvironment = { config, publication, captured: environment };
    }
  }
  return environment;
}

/** Capture the original logical cohort before asynchronous filesystem qualification. */
export function captureSessionStoreInventoryRouting(
  environment: InventoryEnvironment,
  inputAgentIds: readonly string[],
  excludedAgentIds: ReadonlySet<string> = new Set(),
) {
  const { config, env, stateDir } = environment;
  const capturePaths = (agentId: string) => ({
    configured: resolveSessionStorePathCore(config.session?.store, { agentId, env }),
    default: resolveSessionStorePathCore(undefined, { agentId, env }),
  });
  // Only logical configured paths follow config/env publication; physical qualification
  // belongs to this operation's discovery worker.
  const configuredPaths = (environment.configuredPaths ??= new Map(
    listConfiguredSessionStoreAgentIds(config).map((agentId) => [agentId, capturePaths(agentId)]),
  ));
  const agentIds = [...new Set(inputAgentIds.map(normalizeAgentId))];
  const configured = [...configuredPaths.keys()];
  const paths = new Map(
    [...new Set([...agentIds, ...configured])].map((agentId) => [
      agentId,
      configuredPaths.get(agentId) ?? capturePaths(agentId),
    ]),
  );
  const perAgent = isPerAgentSessionStoreConfig(config.session?.store);
  const retired = new Set(agentIds.filter((agentId) => !configured.includes(agentId)));
  const logicalPaths = new Set(
    agentIds
      .filter((agentId) => !excludedAgentIds.has(agentId))
      .flatMap((agentId) => {
        const captured = paths.get(agentId)!;
        return perAgent ? [captured.configured, captured.default] : [captured.configured];
      }),
  );
  if (perAgent && retired.size > 0) {
    for (const agentId of configured) {
      logicalPaths.add(paths.get(agentId)!.configured);
    }
  }
  const roots = new Set([path.join(stateDir, "agents")]);
  for (const value of paths.values()) {
    const root = resolveAgentsDirFromSessionStorePath(value.configured);
    if (root) {
      roots.add(root);
    }
  }
  return { agentIds, paths, logicalPaths, roots, retired, perAgent };
}

export type SessionStoreTargetInventoryRequest = {
  preserveSourceArtifacts?: true;
  selection?: "configured" | "recovery" | "known-owners";
  config: OpenClawConfig;
  agentIds: string[];
  env: NodeJS.ProcessEnv;
  paths: CapturedSessionStorePaths;
  candidates: SessionStoreReadCandidate[];
  recoveryExclusions?: { agentIds: string[]; storePaths: string[]; databasePaths: string[] };
  registryDiscovery?: {
    agentIds: string[];
    roots: Array<{ path: string; physicalPath: string }>;
  };
  registeredDatabases: SessionStoreRegistryRead;
};

export type CapturedSessionStoreTargetInventory = Omit<
  SessionStoreTargetInventoryRequest,
  "registeredDatabases" | "candidates" | "registryDiscovery"
> & {
  logicalPaths: string[];
  roots: string[];
  retiredAgentIds: string[];
};

/** Keep process-owned routing and admission facts on the host before physical qualification. */
export function captureSessionStoreTargetInventory(
  cfg: OpenClawConfig,
  inputAgentIds: readonly string[],
  inputEnv?: NodeJS.ProcessEnv,
  selection?: SessionStoreTargetInventoryRequest["selection"],
  admission: "read" | "write" = "write",
): CapturedSessionStoreTargetInventory {
  const environment = captureSessionStoreEnvironment(cfg, inputEnv);
  const { config, env, serialized } = environment;
  // Background inventories skip unavailable stores before joining their native opening.
  // The preparing owner can still discover its own borrowed admission.
  const refusals =
    selection === "recovery" || selection === "configured"
      ? listAgentDatabaseAdmissionRefusals({ env }).filter((refusal) =>
          admission === "read"
            ? readAgentDatabaseReadAdmissionRefusal(refusal.agentId, { env })
            : readAgentDatabaseAdmissionRefusal(refusal.agentId, { env }),
        )
      : [];
  const excludedAgentIds = new Set(refusals.map((refusal) => refusal.agentId));
  const excludedDatabasePaths = new Set(
    refusals.flatMap((refusal) => refusal.paths.map((pathname) => path.resolve(pathname))),
  );
  const { agentIds, paths, logicalPaths, roots, retired, perAgent } =
    captureSessionStoreInventoryRouting(environment, inputAgentIds, excludedAgentIds);
  return {
    ...(isArtifactPreservingStateRead("agent") ? { preserveSourceArtifacts: true as const } : {}),
    selection,
    config,
    agentIds,
    env: serialized,
    paths,
    logicalPaths: [...logicalPaths],
    roots: [...roots],
    retiredAgentIds: perAgent ? [...retired] : [],
    ...(refusals.length > 0
      ? {
          recoveryExclusions: {
            agentIds: [...excludedAgentIds],
            databasePaths: [...excludedDatabasePaths],
            storePaths: [],
          },
        }
      : {}),
  };
}
