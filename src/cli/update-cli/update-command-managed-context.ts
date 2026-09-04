import { isDeepStrictEqual } from "node:util";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { UpdatePreMutationError } from "./shared.js";
import {
  resolveOwnedManagedUpdateEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";
import type { PreManagedServiceStop } from "./update-command-service.js";

export type OwnedManagedUpdateContext = {
  env: NodeJS.ProcessEnv;
  configSnapshot: ConfigFileSnapshot;
  pluginInstallRecords: Record<string, PluginInstallRecord>;
};

export type OwnedManagedUpdatePreflightContext = Pick<
  OwnedManagedUpdateContext,
  "env" | "configSnapshot"
>;

function resolveOwnedManagedUpdateContextEnv(params: {
  stopState: PreManagedServiceStop | undefined;
  processEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
}): NodeJS.ProcessEnv | undefined {
  const stopState = params.stopState;
  if (stopState?.serviceUpdateVerdict?.kind !== "owned" || !stopState.serviceEnv) {
    return undefined;
  }
  return stripGatewayServiceMarkerEnv(
    resolveOwnedManagedUpdateEnv({
      processEnv: params.processEnv,
      serviceEnv: stopState.serviceEnv,
      serviceDefinitionEnv: stopState.serviceDefinitionEnv,
      invocationCwd: params.invocationCwd,
    }),
  );
}

function assertReadableUpdateConfig(params: {
  configSnapshot: ConfigFileSnapshot;
  label: string;
  reason: "database-schema-preflight" | "managed-service-preflight";
}): void {
  const { configSnapshot } = params;
  if (configSnapshot.valid && !configSnapshot.readError) {
    return;
  }
  const detail = configSnapshot.readError?.code
    ? `read failed (${configSnapshot.readError.code})`
    : "configuration is invalid";
  throw new UpdatePreMutationError(
    params.reason,
    `Update refused: could not safely inspect ${params.label} at ${configSnapshot.path}: ${detail}. No changes were made.`,
  );
}

function assertReadableOwnedManagedConfig(configSnapshot: ConfigFileSnapshot): void {
  assertReadableUpdateConfig({
    configSnapshot,
    label: "managed Gateway config",
    reason: "managed-service-preflight",
  });
}

export function assertReadableCallerUpdateConfig(configSnapshot: ConfigFileSnapshot): void {
  assertReadableUpdateConfig({
    configSnapshot,
    label: "caller OpenClaw config",
    reason: "database-schema-preflight",
  });
}

function updateConfigSnapshotMatches(
  expected: ConfigFileSnapshot,
  current: ConfigFileSnapshot,
): boolean {
  return (
    current.path === expected.path &&
    current.exists === expected.exists &&
    current.raw === expected.raw &&
    current.hash === expected.hash &&
    isDeepStrictEqual(current.includedPaths ?? [], expected.includedPaths ?? []) &&
    isDeepStrictEqual(current.includeProvenance ?? [], expected.includeProvenance ?? []) &&
    isDeepStrictEqual(current.sourceConfig, expected.sourceConfig)
  );
}

/** Run one update phase under the stopped managed Gateway's authoritative environment. */
export async function withOwnedManagedUpdateEnv<T>(
  env: NodeJS.ProcessEnv | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!env) {
    return await run();
  }
  // Update finalization is a single serialized CLI phase. Some plugin/config owners still read
  // process.env, so switch the complete phase atomically and restore the caller afterward.
  const previousEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

export async function captureOwnedManagedUpdateContext(params: {
  stopState: PreManagedServiceStop | undefined;
  processEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
}): Promise<OwnedManagedUpdateContext | undefined> {
  const stopState = params.stopState;
  if (stopState?.stopped !== true) {
    return undefined;
  }
  const env = resolveOwnedManagedUpdateContextEnv(params);
  if (!env) {
    return undefined;
  }
  // Every later doctor, recovery, and restart step consumes serviceEnv. Promote the
  // normalized owned environment before I/O so capture failure recovery targets its owner.
  stopState.serviceEnv = env;
  return await withOwnedManagedUpdateEnv(env, async () => {
    const configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
    assertReadableOwnedManagedConfig(configSnapshot);
    const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords({ env });
    return { env, configSnapshot, pluginInstallRecords };
  });
}

/** Read the owned Gateway's configuration without stopping or mutating its service. */
export async function captureOwnedManagedUpdatePreflightContext(params: {
  stopState: PreManagedServiceStop | undefined;
  processEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
}): Promise<OwnedManagedUpdatePreflightContext | undefined> {
  const env = resolveOwnedManagedUpdateContextEnv(params);
  if (!env) {
    return undefined;
  }
  return await withOwnedManagedUpdateEnv(env, async () => {
    const configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
    assertReadableOwnedManagedConfig(configSnapshot);
    return { env, configSnapshot };
  });
}

/** Re-read the exact caller config before final store admission. */
export async function recaptureCallerUpdateConfig(params: {
  expected: ConfigFileSnapshot;
  env: NodeJS.ProcessEnv;
}): Promise<ConfigFileSnapshot> {
  return await withOwnedManagedUpdateEnv(params.env, async () => {
    const current = await readConfigFileSnapshot({
      skipPluginValidation: true,
      observe: false,
    });
    assertReadableCallerUpdateConfig(current);
    if (!updateConfigSnapshotMatches(params.expected, current)) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        `Update refused: caller OpenClaw config changed during update admission at ${params.expected.path}. No changes were made.`,
      );
    }
    return current;
  });
}

/** Re-read the exact managed Gateway config before final store admission. */
export async function recaptureOwnedManagedUpdateConfig(params: {
  expected: ConfigFileSnapshot;
  env: NodeJS.ProcessEnv;
}): Promise<ConfigFileSnapshot> {
  return await withOwnedManagedUpdateEnv(params.env, async () => {
    const current = await readConfigFileSnapshot({
      skipPluginValidation: true,
      observe: false,
    });
    assertReadableOwnedManagedConfig(current);
    if (!updateConfigSnapshotMatches(params.expected, current)) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        `Update refused: managed Gateway config changed during update admission at ${params.expected.path}. No changes were made.`,
      );
    }
    return current;
  });
}
