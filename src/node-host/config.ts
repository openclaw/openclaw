/** Canonical shared-SQLite configuration for the node-host runner. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import { logInfo } from "../logger.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import {
  normalizeGatewayConfig,
  normalizeNodeHostCommands,
  normalizeStoredNodeHostConfig,
  type NodeHostConfig,
  type NodeHostGatewayConfig,
} from "./config-shared.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";

export type { NodeHostConfig, NodeHostGatewayConfig } from "./config-shared.js";

export const NODE_HOST_CONFIG_KEY = "nodeHost.config";
export const LEGACY_NODE_HOST_CONFIG_FILE = "node.json";
export const LEGACY_NODE_HOST_CONFIG_CLAIM_SUFFIX = ".doctor-importing";

function legacyPathMayExist(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new Error(`unable to verify retired node-host state path ${filePath}`, {
      cause: error,
    });
  }
}

/** Runtime must not choose between canonical SQLite state and a retired file store. */
function assertNodeHostLegacyStateMigrated(env: NodeJS.ProcessEnv = process.env): void {
  const sourcePath = path.join(resolveStateDir(env), LEGACY_NODE_HOST_CONFIG_FILE);
  const claimPath = `${sourcePath}${LEGACY_NODE_HOST_CONFIG_CLAIM_SUFFIX}`;
  if (!legacyPathMayExist(sourcePath) && !legacyPathMayExist(claimPath)) {
    return;
  }
  throw new Error(
    `retired node-host state remains at ${sourcePath}; stop the node host and run \`openclaw doctor --fix\``,
  );
}

/** Read canonical node-host state without creating a store or joining its writable lifecycle. */
export async function loadNodeHostConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NodeHostConfig | null> {
  const selectedEnv = { ...env, OPENCLAW_STATE_DIR: resolveStateDir(env) };
  assertNodeHostLegacyStateMigrated(selectedEnv);
  const reply = await executeExistingOpenClawStateRead(
    { env: selectedEnv },
    {
      type: NODE_HOST_CONFIG_KEY,
    },
  );
  if (!reply) {
    return null;
  }
  if (!reply.ok || reply.type !== NODE_HOST_CONFIG_KEY) {
    throw new Error("Unexpected node-host configuration read result");
  }
  const stored = reply.row;
  if (!stored) {
    return null;
  }
  const value: unknown = JSON.parse(stored.value_json);
  if (!Number.isSafeInteger(stored.updated_at_ms) || stored.updated_at_ms < 0) {
    throw new Error("invalid node-host SQLite row: updated_at_ms must be a non-negative integer");
  }
  return normalizeStoredNodeHostConfig(value);
}

/**
 * Atomically create or replace the complete node-host snapshot.
 * Candidate facts are prepared before BEGIN; the transaction rereads the authoritative row.
 */
export async function configureNodeHost(params: {
  nodeId?: string;
  displayName?: string;
  fallbackDisplayName: string;
  gateway: NodeHostGatewayConfig;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  candidateNodeId?: string;
  installedAppsSharing?: boolean;
  commands?: string[];
  allCommands?: boolean;
}): Promise<NodeHostConfig> {
  const env = params.env ?? process.env;
  assertNodeHostLegacyStateMigrated(env);
  const explicitNodeId = normalizeOptionalString(params.nodeId);
  const explicitDisplayName = normalizeOptionalString(params.displayName);
  const fallbackDisplayName = normalizeOptionalString(params.fallbackDisplayName);
  const candidateNodeId = params.candidateNodeId?.trim() || crypto.randomUUID();
  const gateway = normalizeGatewayConfig(params.gateway);
  const commands =
    params.commands === undefined ? undefined : normalizeNodeHostCommands(params.commands);
  const updatedAtMs = params.nowMs ?? Date.now();
  if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
    throw new Error("invalid node-host updatedAtMs: expected a non-negative integer");
  }

  const worker = new NodeWorkerJournalWorker({ env });
  const { config, clearedCommands } = await worker.execute({
    type: "nodeWorker.configure",
    input: [
      {
        explicitNodeId,
        explicitDisplayName,
        fallbackDisplayName,
        candidateNodeId,
        gateway,
        installedAppsSharing: params.installedAppsSharing,
        commands,
        allCommands: params.allCommands,
        updatedAtMs,
      },
    ],
  });

  if (clearedCommands) {
    logInfo(
      "node-host: cleared saved command allowlist; advertising the full default command surface",
    );
  }
  return config;
}
