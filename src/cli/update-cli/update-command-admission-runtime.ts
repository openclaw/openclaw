import { resolveGatewayNativeServiceIdentityConflict } from "../../daemon/constants.js";
import { disableCurrentOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import { resolveManagedGatewayServiceCommand } from "../../daemon/service-types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { assertNoPendingPackageActivation } from "../../infra/package-update-activation.js";
import { resolveUpdateInstallKind } from "../../infra/update-check.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  createFreeBsdPkgOwnershipInspection,
  type FreeBsdPkgOwnershipInspection,
} from "../../infra/update-freebsd-pkg-ownership.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../../infra/update-managed-service-handoff-cleanup.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import type { UpdateCommandOptions } from "./shared.js";
import { resolveForegroundUpdateAdmission } from "./update-command-handoff.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";
import {
  resolveOwnedManagedUpdateEnv,
  resolveServiceRefreshEnv,
  withOwnedManagedUpdateEnv,
} from "./update-command-service-env.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  isGatewayServiceManagementAllowedForUpdate,
  readManagedGatewayServiceForUpdate,
} from "./update-command-service-plan.js";

export async function resolveUpdateCommandAdmissionEnvCore(params: {
  opts: UpdateCommandOptions;
  root: string;
  invocationCwd?: string;
  pkgOwnership?: FreeBsdPkgOwnershipInspection;
  expectedForeground?: true;
}): Promise<NodeJS.ProcessEnv> {
  const pkgOwnership =
    params.pkgOwnership ?? createFreeBsdPkgOwnershipInspection(UPDATE_RUNNER_TIMEOUT_MS);
  await pkgOwnership.assertUnowned(params.root);
  let env = resolveServiceRefreshEnv(process.env, params.invocationCwd);
  if (
    await resolveForegroundUpdateAdmission({
      root: params.root,
      env,
      expectedForeground:
        params.expectedForeground ||
        params.opts.run?.completionOwner === "gateway-restart" ||
        undefined,
    })
  ) {
    return env;
  }
  if (
    !params.opts.dryRun &&
    !env[UPDATE_RUN_ID_ENV] &&
    isGatewayServiceManagementAllowedForUpdate(env)
  ) {
    const inspected = await readManagedGatewayServiceForUpdate(
      env,
      params.root,
      (await resolveUpdateInstallKind(params.root)) === "package",
    );
    if (inspected) {
      env = resolveOwnedManagedUpdateEnv({
        processEnv: env,
        serviceEnv: mergeGatewayServiceEnv(env, inspected.command),
        serviceDefinitionEnv: resolveManagedGatewayServiceCommand(inspected.command)?.environment,
        invocationCwd: params.invocationCwd,
      });
      if (resolveGatewayNativeServiceIdentityConflict(env)) {
        assertGatewayServiceManagementAllowedForUpdate(env);
      }
    }
  }
  return env;
}

export function assertUpdatePackageActivationAdmissionCore(
  root: string,
  options?: Parameters<typeof assertNoPendingPackageActivation>[1] & { serviceRoot?: string },
): void {
  try {
    assertNoPendingPackageActivation(resolveUpdateInstallRoot(root), options);
  } catch (cause) {
    throw new UpdateCommandPendingRecoveryFailure(
      {
        status: "error",
        mode: "unknown",
        root,
        reason: "update-recovery-pending",
        steps: [],
        durationMs: 0,
      },
      formatErrorMessage(cause),
      { cause },
    );
  }
  if (options?.serviceRoot && options.serviceRoot !== root) {
    assertUpdatePackageActivationAdmissionCore(options.serviceRoot, {
      continuation: options.continuation,
      dryRun: options.dryRun,
    });
  }
}

export async function prepareMutableUpdateRuntimeCore(
  env: NodeJS.ProcessEnv | undefined,
  fence: UpdateRecoveryFence,
) {
  return await withOwnedManagedUpdateEnv(env, async () => {
    fence.assertCurrent();
    await cleanupStaleManagedServiceUpdateHandoffs().catch(() => undefined);
    fence.assertCurrent();
    await assertOpenClawStateWriteAllowedAtPath({
      databasePath: resolveOpenClawStateSqlitePath(process.env),
    });
    fence.assertCurrent();
    await disableCurrentOpenClawUpdateLaunchdJob().catch(() => undefined);
    fence.assertCurrent();
    const records = await loadInstalledPluginIndexInstallRecords();
    fence.assertCurrent();
    return records;
  });
}
