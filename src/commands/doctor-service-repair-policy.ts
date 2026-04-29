import {
  GATEWAY_LAUNCH_AGENT_LABEL,
  MAC_APP_LAUNCH_AGENT_LABEL,
  resolveGatewayLaunchAgentLabel,
} from "../daemon/constants.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

export type ServiceRepairPolicy = "auto" | "external";

export const SERVICE_REPAIR_POLICY_ENV = "OPENCLAW_SERVICE_REPAIR_POLICY";

export const EXTERNAL_SERVICE_REPAIR_NOTE =
  "Gateway service is managed externally; skipped service install/start repair. Start or repair the gateway through your supervisor.";

export function resolveServiceRepairPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ServiceRepairPolicy {
  const value = env[SERVICE_REPAIR_POLICY_ENV]?.trim().toLowerCase();
  switch (value) {
    case "auto":
    case "external":
      return value;
    default:
      return "auto";
  }
}

export function isServiceRepairExternallyManaged(
  policy: ServiceRepairPolicy = resolveServiceRepairPolicy(),
): boolean {
  return policy === "external";
}

export function shouldMacAppLaunchAgentOwnGatewayRepair(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const targetLabel = resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
  return targetLabel === GATEWAY_LAUNCH_AGENT_LABEL || targetLabel === MAC_APP_LAUNCH_AGENT_LABEL;
}

export function renderMacAppLaunchAgentRepairSkip(
  ownership: {
    label: string;
    installed: boolean;
    loaded: boolean;
    detail: string;
  },
  params: {
    env?: Record<string, string | undefined>;
    skippedAction: string;
  },
): string {
  const targetLabel = resolveGatewayLaunchAgentLabel(params.env?.OPENCLAW_PROFILE);
  const state =
    ownership.installed && ownership.loaded
      ? "installed and loaded"
      : ownership.loaded
        ? "loaded"
        : "installed";
  return [
    `OpenClaw.app LaunchAgent ${ownership.label} is ${state}.`,
    `Ownership path: OpenClaw.app manages the local macOS gateway lifecycle for ${targetLabel}.`,
    `Skipped ${params.skippedAction}. Use OpenClaw.app to repair or restart Local mode, or disable the app LaunchAgent before using CLI service repair.`,
    `Detected ${ownership.detail}.`,
  ].join("\n");
}

export async function confirmDoctorServiceRepair(
  prompter: DoctorPrompter,
  params: Parameters<DoctorPrompter["confirmRuntimeRepair"]>[0],
  policy: ServiceRepairPolicy = resolveServiceRepairPolicy(),
): Promise<boolean> {
  if (isServiceRepairExternallyManaged(policy)) {
    return false;
  }

  return await prompter.confirmRuntimeRepair(params);
}
