import type { AutomationCreationSlot } from "../../../../src/shared/automation-creation.js";

export type AutomationCreationRow = AutomationCreationSlot & { jobId: string };
export type AutomationCreationCardPlan = {
  grouped: boolean;
  rows: readonly AutomationCreationRow[];
};

/** Only the local transcript projector can construct this display block. */
export class AutomationCreationCardBlock {
  readonly type = "automation_creation_card";
  constructor(readonly plan: AutomationCreationCardPlan) {}
}
