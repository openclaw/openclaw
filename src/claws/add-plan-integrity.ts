import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import type { ClawAddPlan, ClawDiagnostic } from "./types.js";

type ClawAddPlanIntegrityInput = Pick<
  ClawAddPlan,
  | "manifestSchemaVersion"
  | "claw"
  | "agent"
  | "actions"
  | "capabilityChanges"
  | "blockers"
  | "extensions"
> & {
  // Nonblocking agent-configuration notices bind into the digest so a resume re-derives them;
  // optional so callers that never produce notices keep their prior digest unchanged.
  notices?: ClawDiagnostic[];
};

export function digestClawAddPlanIntegrity(plan: ClawAddPlanIntegrityInput): string {
  const notices = plan.notices ?? [];
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
