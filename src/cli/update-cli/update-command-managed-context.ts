import { isDeepStrictEqual } from "node:util";
import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import {
  createManagedUpdateRequesterContinuationAuthority,
  UpdateRequesterRevokedError,
} from "../../infra/update-requester-authority.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { defaultRuntime } from "../../runtime.js";
import {
  captureTargetDatabaseSchemaContext,
  updateConfigSource,
  isCandidateAdmissionContextCovered,
  type TargetDatabaseSchemaContextOptions,
} from "./schema-preflight.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { UpdateCommandExecutor } from "./update-command-executor.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import {
  resolveOwnedManagedUpdateEnv,
  stripGatewayServiceMarkerEnv,
  withOwnedManagedUpdateEnv,
} from "./update-command-service-env.js";

export type OwnedManagedUpdateContext = NonNullable<
  Awaited<ReturnType<typeof captureOwnedManagedUpdateContext>>
>;

/** Resolve the service's selectors without reading or validating its configuration. */
export function resolveOwnedManagedUpdatePreflightEnv(params: {
  stopState: PreManagedServiceStop | undefined;
  processEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
}) {
  const state = params.stopState;
  if (state?.serviceUpdateVerdict?.kind !== "owned" || !state.serviceEnv) {
    return undefined;
  }
  return stripGatewayServiceMarkerEnv(
    resolveOwnedManagedUpdateEnv({
      processEnv: params.processEnv,
      serviceEnv: state.serviceEnv,
      serviceDefinitionEnv: state.serviceDefinitionEnv,
      invocationCwd: params.invocationCwd,
    }),
  );
}

/** Inspection uses the same service selectors as finalization, without activating config/plugins. */
export async function captureOwnedManagedUpdatePreflightContext(
  params: {
    stopState: PreManagedServiceStop | undefined;
    processEnv: NodeJS.ProcessEnv;
    invocationCwd?: string;
  } & TargetDatabaseSchemaContextOptions,
) {
  const env = resolveOwnedManagedUpdatePreflightEnv(params);
  return env ? captureTargetDatabaseSchemaContext(env, params) : undefined;
}

export async function revalidateUpdateDatabaseContext(
  expected: Awaited<ReturnType<typeof captureTargetDatabaseSchemaContext>>,
) {
  const current = await captureTargetDatabaseSchemaContext(expected.readEnv, {
    legacyConfigPlan: expected.legacyConfigPlan,
    configValidation: expected.configValidation,
  });
  const before = expected.configSnapshot;
  if (!isDeepStrictEqual(updateConfigSource(before), updateConfigSource(current.configSnapshot))) {
    defaultRuntime.error(
      `Warning: Configuration changed during database admission at ${before.path}; continuing with the current configuration.`,
    );
  }
  return current;
}

export async function captureOwnedManagedUpdateContext(params: {
  stopState: PreManagedServiceStop | undefined;
  processEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
}) {
  const stopState = params.stopState;
  if (stopState?.inspected !== true) {
    return undefined;
  }
  const env = resolveOwnedManagedUpdatePreflightEnv(params);
  if (!env) {
    return undefined;
  }
  // Every later schema, doctor, recovery, and restart step consumes serviceEnv. Promote the
  // normalized owned environment before I/O so even capture failure recovery targets its owner.
  stopState.serviceEnv = env;
  return await withOwnedManagedUpdateEnv(env, async () => {
    const configSnapshot = await readConfigFileSnapshot({
      observe: false,
      skipPluginValidation: true,
    });
    const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords({ env });
    return { env, configSnapshot, pluginInstallRecords };
  });
}

export async function readUpdateCandidateSource(
  env: NodeJS.ProcessEnv,
  legacyConfigPlan?: LegacyConfigUpdatePlan,
  options?: Pick<TargetDatabaseSchemaContextOptions, "configValidation">,
) {
  if (legacyConfigPlan) {
    const context = await captureTargetDatabaseSchemaContext(env, {
      legacyConfigPlan,
      ...options,
    });
    if (context.legacyConfigPlan) {
      return {
        config: context.config,
        hash: hashConfigRaw(context.configSnapshot.raw),
        source: updateConfigSource(context.configSnapshot),
      };
    }
  }
  const snapshot = await withOwnedManagedUpdateEnv(env, () =>
    readConfigFileSnapshot({ skipPluginValidation: true, observe: false }),
  );
  return {
    config:
      options?.configValidation === "candidate" && isCandidateAdmissionContextCovered(env)
        ? snapshot.sourceConfig
        : snapshot.config,
    hash: hashConfigRaw(snapshot.raw),
    source: updateConfigSource(snapshot),
  };
}

/** Complete native admission before any execution guard can observe the pending requester. */
export async function admitUpdateRequesterContinuation(
  run: NonNullable<UpdateCommandOptions["run"]>,
  executor: UpdateCommandExecutor,
  root: string,
  serviceRoot?: string,
): Promise<void> {
  const original = run.requesterAuthority;
  const requester = original?.requester;
  if (!requester?.authorizationSource?.startsWith("profile:")) {
    return;
  }
  const runId = run.runId;
  const previousFence = run.executorFence;
  const fence = await executor.enter(root, { preflight: true, serviceRoot });
  const assertRunCurrent = () => {
    if (
      run.runId !== runId ||
      run.requesterAuthority !== original ||
      run.executorFence !== previousFence ||
      (previousFence && previousFence !== fence)
    ) {
      throw new UpdateRequesterRevokedError();
    }
    fence.assertCurrent();
  };
  assertRunCurrent();
  const continued = await createManagedUpdateRequesterContinuationAuthority(
    requester,
    { runId, executor: fence },
    run.env,
  );
  assertRunCurrent();
  run.requesterAuthority = continued;
  run.executorFence = fence;
}
