/** Doctor policy for native gateway service ownership and repair. */
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { isContainerEnvironment } from "../infra/container-environment.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  UPDATE_IN_PROGRESS_ENV,
  UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION_ENV,
} from "./doctor/shared/update-phase.js";

type ServiceRepairPolicy = "auto" | "external" | "update";
const GATEWAY_SERVICE_MANAGER_TIMEOUT_MS = 5_000;

export const SERVICE_REPAIR_POLICY_ENV = "OPENCLAW_SERVICE_REPAIR_POLICY";

const EXTERNAL_SERVICE_REPAIR_NOTE =
  "Gateway service is managed externally; skipped service install/start repair. Start or repair the gateway through your supervisor.";

export function assertDoctorServiceSelection(
  env: NodeJS.ProcessEnv,
  serviceEnv: NodeJS.ProcessEnv,
): void {
  const selection = (candidate: NodeJS.ProcessEnv) => {
    const stateDir = resolveStateDir(candidate);
    return [stateDir, resolveConfigPath(candidate, stateDir)].map((value) =>
      resolvePathViaExistingAncestorSync(value),
    );
  };
  const before = selection(env);
  if (selection(serviceEnv).some((value, index) => value !== before[index])) {
    throw new Error(
      "Doctor and the managed Gateway select different config or state directories. Run doctor with the Gateway's installation and profile; the service was left unchanged.",
    );
  }
}

/** Missing activation policy belongs to legacy parents, not an explicit denial. */
export function resolveUpdateParentGatewayActivation(env: NodeJS.ProcessEnv): boolean | undefined {
  const policy = env[UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION_ENV];
  return policy === undefined ? undefined : isTruthyEnvValue(policy);
}

export async function shouldManageGatewayService(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (
    isGatewayExternallySupervised(env) ||
    (env.KUBERNETES_SERVICE_HOST?.trim() && env.KUBERNETES_SERVICE_PORT?.trim())
  ) {
    return false;
  }
  if (!isContainerEnvironment()) {
    return true;
  }
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const { findInstalledSystemdGatewayScope } = await import("../daemon/systemd.js");
    // Container placement is not ownership; user Doctor can repair only its
    // installed user unit through a reachable systemd user manager.
    if ((await findInstalledSystemdGatewayScope(env))?.scope !== "user") {
      return false;
    }
    const { resolveGatewayService } = await import("../daemon/service.js");
    await resolveGatewayService().isLoaded({ env, timeoutMs: GATEWAY_SERVICE_MANAGER_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** The existing updater marker selects internal deferral, not external supervision. */
export function resolveServiceRepairPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ServiceRepairPolicy {
  // Published updater parents already set this marker. Finalization owns the
  // backed-up installer rewrite; Doctor must not publish an earlier definition.
  if (env[SERVICE_REPAIR_POLICY_ENV]?.trim().toLowerCase() === "external") {
    return "external";
  }
  return isTruthyEnvValue(env[UPDATE_IN_PROGRESS_ENV]) ? "update" : "auto";
}

/** Returns true when Doctor service mutations must defer to an external supervisor. */
export function isServiceRepairExternallyManaged(
  policy: ServiceRepairPolicy = resolveServiceRepairPolicy(),
): boolean {
  return policy === "external" || isGatewayExternallySupervised();
}

/** Maintenance inspection remains separate from publishing or activating a service. */
export function isServiceRepairDeferred(
  policy: ServiceRepairPolicy = resolveServiceRepairPolicy(),
): boolean {
  return policy === "update" || isServiceRepairExternallyManaged(policy);
}

export function formatServiceRepairDeferredNote(
  policy: ServiceRepairPolicy = resolveServiceRepairPolicy(),
): string {
  return policy === "update"
    ? "Gateway service repair deferred to update finalization; Doctor left its definition and activation unchanged."
    : EXTERNAL_SERVICE_REPAIR_NOTE;
}

/** Confirms a service repair only when Doctor owns publication and activation. */
export async function confirmDoctorServiceRepair(
  prompter: DoctorPrompter,
  params: Parameters<DoctorPrompter["confirmRuntimeRepair"]>[0],
  policy: ServiceRepairPolicy = resolveServiceRepairPolicy(),
): Promise<boolean> {
  return !isServiceRepairDeferred(policy) && (await prompter.confirmRuntimeRepair(params));
}
