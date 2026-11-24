import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readAutomationSavedDefinition,
  type AutomationSavedDefinition,
} from "./automation-saved-definition.js";

export type AutomationCreationSlot = { slotId: string; name: string };
export type AutomationCreationPlan = {
  type: "automation_creation_plan";
  planId: string;
  slots: AutomationCreationSlot[];
};
/** Positions are public, one-based references into this exact declaration, never arrival order. */
export function automationSlotAtPosition(plan: AutomationCreationPlan, position: unknown) {
  const ordinal = position === undefined && plan.slots.length === 1 ? 1 : position;
  return typeof ordinal === "number" && Number.isInteger(ordinal) && ordinal >= 1
    ? plan.slots[ordinal - 1]
    : undefined;
}
export type AutomationCreationResult = {
  type: "automation_creation_result";
  planId: string;
  slotId: string;
} & (
  | { status: "created"; jobId: string; definition?: AutomationSavedDefinition }
  | { status: "failed" }
);
export type AutomationCreationEvent = AutomationCreationPlan | AutomationCreationResult;

function identity(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 1024 && value.trim() === value
  );
}

/** The plan fixes cardinality and order. Only a persisted scheduler ID can resolve a slot as created. */
export function readAutomationCreationEvent(value: unknown): AutomationCreationEvent | undefined {
  const raw = asOptionalRecord(value);
  if (!raw || !identity(raw.planId)) {
    return undefined;
  }
  const { type, planId } = raw;
  if (type === "automation_creation_result" && identity(raw.slotId)) {
    const { slotId, status } = raw;
    if (status === "failed") {
      return { type, planId, slotId, status };
    }
    if (status === "created" && identity(raw.jobId)) {
      const definition = readAutomationSavedDefinition(raw.definition, raw.jobId);
      return {
        type,
        planId,
        slotId,
        status,
        jobId: raw.jobId,
        ...(definition ? { definition } : {}),
      };
    }
  }
  if (type !== "automation_creation_plan" || !Array.isArray(raw.slots) || raw.slots.length === 0) {
    return undefined;
  }
  const slots: AutomationCreationSlot[] = [];
  const ids = new Set<string>();
  for (const entry of raw.slots) {
    const slot = asOptionalRecord(entry);
    if (
      !slot ||
      !identity(slot.slotId) ||
      ids.has(slot.slotId) ||
      typeof slot.name !== "string" ||
      !slot.name.trim()
    ) {
      return undefined;
    }
    ids.add(slot.slotId);
    slots.push({ slotId: slot.slotId, name: slot.name });
  }
  return { type, planId, slots };
}
