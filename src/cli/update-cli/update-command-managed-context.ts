import { isDeepStrictEqual } from "node:util";
import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import { UpdatePreMutationError } from "./shared.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import {
  resolveOwnedManagedUpdateEnv,
  stripGatewayServiceMarkerEnv,
  withOwnedManagedUpdateEnv,
} from "./update-command-service-env.js";

export type OwnedManagedUpdateContext = {
  env: NodeJS.ProcessEnv;
  configSnapshot: ConfigFileSnapshot;
  pluginInstallRecords: Record<string, PluginInstallRecord>;
};

/** Inspection uses the same service selectors as finalization, without activating config/plugins. */
export async function captureOwnedManagedUpdatePreflightContext(params: {
  stopState: PreManagedServiceStop | undefined;
  processEnv: NodeJS.ProcessEnv;
  invocationCwd?: string;
  legacyConfigPlan?: LegacyConfigUpdatePlan;
}) {
  const state = params.stopState;
  if (state?.serviceUpdateVerdict?.kind !== "owned" || !state.serviceEnv) {
    return undefined;
  }
  return captureTargetDatabaseSchemaContext(
    stripGatewayServiceMarkerEnv(
      resolveOwnedManagedUpdateEnv({
        processEnv: params.processEnv,
        serviceEnv: state.serviceEnv,
        serviceDefinitionEnv: state.serviceDefinitionEnv,
        invocationCwd: params.invocationCwd,
      }),
    ),
    { legacyConfigPlan: params.legacyConfigPlan },
  );
}

export async function revalidateUpdateDatabaseContext(
  expected: Awaited<ReturnType<typeof captureTargetDatabaseSchemaContext>>,
) {
  const current = await captureTargetDatabaseSchemaContext(expected.readEnv, {
    legacyConfigPlan: expected.legacyConfigPlan,
  });
  const before = expected.configSnapshot;
  const after = current.configSnapshot;
  if (
    before.path !== after.path ||
    before.exists !== after.exists ||
    before.raw !== after.raw ||
    before.hash !== after.hash ||
    !isDeepStrictEqual(before.includedPaths ?? [], after.includedPaths ?? []) ||
    !isDeepStrictEqual(before.includeProvenance ?? [], after.includeProvenance ?? []) ||
    !isDeepStrictEqual(before.sourceConfig, after.sourceConfig)
  ) {
    throw new UpdatePreMutationError(
      "database-schema-preflight",
      `Update refused: configuration changed during database admission at ${before.path}. Retry against the current configuration.`,
    );
  }
  return current;
}

export async function captureOwnedManagedUpdateContext(params: {
  stopState: PreManagedServiceStop | undefined;
  processEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
}): Promise<OwnedManagedUpdateContext | undefined> {
  const stopState = params.stopState;
  if (
    stopState?.inspected !== true ||
    stopState.serviceUpdateVerdict?.kind !== "owned" ||
    !stopState.serviceEnv
  ) {
    return undefined;
  }
  const env = stripGatewayServiceMarkerEnv(
    resolveOwnedManagedUpdateEnv({
      processEnv: params.processEnv,
      serviceEnv: stopState.serviceEnv,
      serviceDefinitionEnv: stopState.serviceDefinitionEnv,
      invocationCwd: params.invocationCwd,
    }),
  );
  // Every later schema, doctor, recovery, and restart step consumes serviceEnv. Promote the
  // normalized owned environment before I/O so even capture failure recovery targets its owner.
  stopState.serviceEnv = env;
  return await withOwnedManagedUpdateEnv(env, async () => {
    const configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
    const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords({ env });
    return { env, configSnapshot, pluginInstallRecords };
  });
}
