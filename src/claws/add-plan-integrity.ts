import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import type { ClawAddPlan } from "./types.js";

type ClawAddPlanIntegrityInput = Pick<
  ClawAddPlan,
  | "manifestSchemaVersion"
  | "claw"
  | "agent"
  | "actions"
  | "capabilityChanges"
  | "blockers"
  | "extensions"
> &
  Partial<Pick<ClawAddPlan, "diagnostics">>;

export function digestClawAddPlanIntegrity(plan: ClawAddPlanIntegrityInput): string {
  const notices = (plan.diagnostics ?? []).filter(
    (diagnostic) =>
      diagnostic.level === "warning" &&
      diagnostic.phase === "plan" &&
      diagnostic.path.startsWith("$.profiles.openclaw.agent."),
  );
  return `sha256:${createHash("sha256")
    .update(
      stableStringify({
        manifestSchemaVersion: plan.manifestSchemaVersion,
        clawIntegrity: plan.claw.integrity,
        finalId: plan.agent.finalId,
        workspace: plan.agent.workspace,
        actions: plan.actions,
        capabilityChanges: plan.capabilityChanges,
        blockers: plan.blockers,
        extensions: plan.extensions,
        ...(notices.length > 0 ? { notices } : {}),
      }),
    )
    .digest("hex")}`;
}
