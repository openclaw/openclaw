import { resolveGatewayNativeServiceIdentityConflict } from "../../daemon/constants.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import { resolveManagedGatewayServiceCommand } from "../../daemon/service-types.js";
import { resolveUpdateInstallKind } from "../../infra/update-check.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import {
  createFreeBsdPkgOwnershipInspection,
  type FreeBsdPkgOwnershipInspection,
} from "../../infra/update-freebsd-pkg-ownership.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import type { UpdateCommandOptions } from "./shared.js";
import { assertFreeBsdUpdateCommandRunOrigin } from "./update-command-freebsd-policy.js";
import { resolveForegroundUpdateAdmission } from "./update-command-handoff.js";
import {
  resolveOwnedManagedUpdateEnv,
  resolveServiceRefreshEnv,
} from "./update-command-service-env.js";
import {
  assertGatewayServiceManagementAllowedForUpdate,
  isGatewayServiceManagementAllowedForUpdate,
  readManagedGatewayServiceForUpdate,
  type resolveManagedServicePackageUpdatePlan,
} from "./update-command-service-plan.js";

/** Admission follows the managed service root before a redirect or discovered install. */
export function resolveUpdateCommandAdmissionRoot(prepared: {
  servicePlan: Awaited<ReturnType<typeof resolveManagedServicePackageUpdatePlan>> | undefined;
  discoveredRoot: string;
}): string {
  return (
    prepared.servicePlan?.serviceRoot ??
    prepared.servicePlan?.rootRedirect?.root ??
    prepared.discoveredRoot
  );
}

export async function resolveUpdateCommandAdmissionEnv(params: {
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
  const foreground = await resolveForegroundUpdateAdmission({
    root: params.root,
    env,
    expectedForeground:
      params.expectedForeground ||
      params.opts.run?.completionOwner === "gateway-restart" ||
      undefined,
  });
  // A preview belongs to its explicit state directory. Real updates follow the
  // same owned service selectors as finalization, then freeze them for all writers.
  if (
    !foreground &&
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
      // Contradictory native identity must refuse before database or target selection.
      if (resolveGatewayNativeServiceIdentityConflict(env)) {
        assertGatewayServiceManagementAllowedForUpdate(env);
      }
    }
  }
  assertFreeBsdUpdateCommandRunOrigin(params.opts, env);
  return env;
}
