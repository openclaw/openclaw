import type { DoctorPrompter } from "./doctor-prompter.js";

export type ServiceRepairPolicy = "auto" | "prompt" | "external" | "disabled";

export const SERVICE_REPAIR_POLICY_ENV = "OPENCLAW_SERVICE_REPAIR_POLICY";

export const EXTERNAL_SERVICE_REPAIR_NOTE =
  "Gateway service is managed externally; skipped service install/start repair. Start or repair the gateway through your supervisor.";

export function resolveServiceRepairPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ServiceRepairPolicy {
  const value = env[SERVICE_REPAIR_POLICY_ENV]?.trim().toLowerCase();
  switch (value) {
    case "auto":
    case "prompt":
    case "external":
    case "disabled":
      return value;
    default:
      return "auto";
  }
}

export function isServiceRepairExternallyManaged(
  policy: ServiceRepairPolicy = resolveServiceRepairPolicy(),
): boolean {
  return policy === "external" || policy === "disabled";
}

export async function confirmDoctorServiceRepair(
  prompter: DoctorPrompter,
  params: Parameters<DoctorPrompter["confirmRuntimeRepair"]>[0],
  policy: ServiceRepairPolicy = resolveServiceRepairPolicy(),
): Promise<boolean> {
  if (isServiceRepairExternallyManaged(policy)) {
    return false;
  }

  if (policy === "prompt") {
    if (!prompter.repairMode.canPrompt) {
      return false;
    }
    return await (prompter.confirmServiceRepair?.(params) ?? prompter.confirmRuntimeRepair(params));
  }

  return await prompter.confirmRuntimeRepair(params);
}
