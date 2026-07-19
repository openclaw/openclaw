import {
  readConfigFileSnapshotWithPluginMetadata,
  type ReadConfigFileSnapshotWithPluginMetadataResult,
} from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import { normalizeStateDirEnv } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import {
  preflightOpenClawDatabaseSchemas,
  type OpenClawDatabaseSchemaPreflight,
} from "../state/openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db.js";

export const GATEWAY_STARTUP_VERIFY_PROTOCOL = "openclaw.gateway.verify";
export const GATEWAY_STARTUP_VERIFY_PROTOCOL_VERSION = 1;

export type GatewayStartupVerifyResult = {
  ok: true;
  protocol: typeof GATEWAY_STARTUP_VERIFY_PROTOCOL;
  protocolVersion: typeof GATEWAY_STARTUP_VERIFY_PROTOCOL_VERSION;
  checks: {
    config: "valid";
    databases: "read-only";
    providers: "initialized";
  };
  models: number;
};

type GatewayStartupVerifyDeps = {
  readConfig: () => Promise<ReadConfigFileSnapshotWithPluginMetadataResult>;
  preflightDatabases: (params: {
    env: NodeJS.ProcessEnv;
    supportedVersions: { state: number; agent: number };
  }) => OpenClawDatabaseSchemaPreflight;
  loadModelCatalog: (params: {
    config: OpenClawConfig;
    metadataSnapshot?: PluginMetadataSnapshot;
    readOnly: true;
  }) => Promise<{ entries: readonly unknown[] }>;
};

const defaultDeps: GatewayStartupVerifyDeps = {
  readConfig: () => readConfigFileSnapshotWithPluginMetadata({ isolateEnv: true, observe: false }),
  preflightDatabases: preflightOpenClawDatabaseSchemas,
  loadModelCatalog: async (params) => {
    const { verifyModelProviderRuntimeReadOnly } = await import("../agents/model-catalog.js");
    return await verifyModelProviderRuntimeReadOnly(params);
  },
};

/** Side-effect-free startup proof used before a managed package swap. */
export async function verifyGatewayStartup(
  params: {
    env?: NodeJS.ProcessEnv;
    deps?: GatewayStartupVerifyDeps;
  } = {},
): Promise<GatewayStartupVerifyResult> {
  const env = params.env ?? process.env;
  const deps = params.deps ?? defaultDeps;
  normalizeStateDirEnv(env);

  const configRead = await deps.readConfig();
  const snapshot = configRead.snapshot;
  if (!snapshot.valid) {
    const detail =
      snapshot.issues.length > 0
        ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n")
        : "Unknown validation issue.";
    throw new Error(`Gateway startup verify rejected config ${snapshot.path}: ${detail}`);
  }

  const schemas = deps.preflightDatabases({
    env,
    supportedVersions: {
      state: OPENCLAW_STATE_SCHEMA_VERSION,
      agent: OPENCLAW_AGENT_SCHEMA_VERSION,
    },
  });
  if (schemas.incompatible.length > 0 || schemas.indeterminate.length > 0) {
    const details = [
      ...schemas.incompatible.map(
        (database) =>
          `${database.kind} database ${database.path} has schema ${database.foundVersion}; supported ${database.supportedVersion}`,
      ),
      ...schemas.indeterminate.map(
        (database) =>
          `${database.kind} database ${database.path} could not be read: ${database.reason}`,
      ),
    ];
    throw new Error(`Gateway startup verify rejected SQLite state: ${details.join("; ")}`);
  }

  // readOnly is the contract: provider/catalog initialization may inspect existing
  // stores, but it cannot create caches, auth profiles, or migration artifacts.
  const catalog = await deps.loadModelCatalog({
    config: snapshot.runtimeConfig,
    ...(configRead.pluginMetadataSnapshot
      ? { metadataSnapshot: configRead.pluginMetadataSnapshot }
      : {}),
    readOnly: true,
  });

  return {
    ok: true,
    protocol: GATEWAY_STARTUP_VERIFY_PROTOCOL,
    protocolVersion: GATEWAY_STARTUP_VERIFY_PROTOCOL_VERSION,
    checks: {
      config: "valid",
      databases: "read-only",
      providers: "initialized",
    },
    models: catalog.entries.length,
  };
}
