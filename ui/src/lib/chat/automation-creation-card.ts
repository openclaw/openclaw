import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AutomationCreationSlot } from "../../../../src/shared/automation-creation.js";
import type { AutomationSavedDefinition } from "../../../../src/shared/automation-saved-definition.js";

// Runtime-only provenance, not a serializable transcript permission. A paginated or
// reloaded result must go through cron.get, even if its declaration was already mounted.
const liveInstallerBlocks = new WeakSet<object>();
export function rememberLiveAutomationInjection(message: Record<string, unknown>) {
  const block = Array.isArray(message.content) ? asOptionalRecord(message.content[0]) : undefined;
  if (block?.type === "automation_creation_result" && block.status === "created") {
    liveInstallerBlocks.add(block);
  }
}
export function isLiveAutomationInjection(message: unknown) {
  const content = asOptionalRecord(message)?.content;
  return Array.isArray(content) && liveInstallerBlocks.has(content[0]);
}

export type AutomationCreationRow = AutomationCreationSlot &
  (
    | { status: "pending" | "failed" }
    | { status: "created"; jobId: string; definition?: AutomationSavedDefinition }
  );
export type AutomationCreationCardPlan = { planId: string; rows: readonly AutomationCreationRow[] };

/** Only the local transcript projector can construct this display block. */
export class AutomationCreationCardBlock {
  readonly type = "automation_creation_card";
  constructor(readonly plan: AutomationCreationCardPlan) {}
}
