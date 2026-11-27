import { note } from "../../packages/terminal-core/src/note.js";
import { resolveAgentWorkspaceDir, tryResolveSoleAgentId } from "../agents/agent-scope.js";
import { measureGatewayBootstrapStep } from "../cli/startup-trace.js";
import { traceDoctorMaintenancePending } from "../commands/doctor-maintenance-pending.js";
import {
  isLegacyParentWritableUpdateDoctorPass,
  isUpdateDoctorInspectionReportMode,
} from "../commands/doctor/shared/update-phase.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import type {
  DoctorHealthContribution,
  DoctorHealthFlowContext,
} from "./doctor-health-contribution-types.js";

export function isUpdateDoctorRun(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  const value = env.OPENCLAW_UPDATE_IN_PROGRESS;
  return value === "1" || value === "true";
}

export function shouldDeferPostActivationInspections(env: NodeJS.ProcessEnv): boolean {
  return (
    isUpdateDoctorRun(env) &&
    !resolveUpdateRehearsalRoot(env) &&
    isUpdateDoctorInspectionReportMode(env)
  );
}

export function resolveDoctorMode(cfg: OpenClawConfig): "local" | "remote" {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}
export function resolveDoctorWorkspaceDir(cfg: OpenClawConfig, env = process.env) {
  const agentId = tryResolveSoleAgentId(cfg);
  return agentId ? resolveAgentWorkspaceDir(cfg, agentId, env) : undefined;
}

export function resolveLegacyParentVersionOverride(ctx: DoctorHealthFlowContext): {
  lastTouchedVersionOverride?: string;
} {
  if (!isLegacyParentWritableUpdateDoctorPass(ctx.env ?? process.env)) {
    return {};
  }
  const version = ctx.configResult.sourceLastTouchedVersion?.trim();
  return version ? { lastTouchedVersionOverride: version } : {};
}

export function noteDoctorRepairResult(result: {
  changes: readonly string[];
  notices?: readonly string[];
  warnings: readonly string[];
}): void {
  for (const kind of ["changes", "notices", "warnings"] as const) {
    if (result[kind]?.length) {
      note(result[kind].join("\n"), `Doctor ${kind}`);
    }
  }
}

/** Times one contribution; under Gateway maintenance it first traces whether it has work. */
export async function measureDoctorContribution(
  ctx: DoctorHealthFlowContext,
  contribution: DoctorHealthContribution,
  run: () => Promise<void>,
): Promise<void> {
  if (ctx.gatewayMaintenanceActive) {
    const { pending } = contribution;
    await traceDoctorMaintenancePending(
      `contribution.${contribution.id}`,
      pending === "diagnostic-only" ? () => "none" : pending ? () => pending(ctx) : undefined,
    );
  }
  await measureGatewayBootstrapStep(`doctor.contribution.${contribution.id}`, run);
}
