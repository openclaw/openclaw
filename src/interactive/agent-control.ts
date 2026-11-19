import { asOptionalRecord as toRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";

// An empty namespace is unregistrable, so no plugin claims a value by its mark.
const AGENT_CONTROL_MARK = "::";

function stampAgentControl(control: unknown): unknown {
  const record = toRecord(control);
  const action = toRecord(record?.action);
  // A typed control carries its value on the action; a legacy control carries it inline.
  const target =
    action && normalizeOptionalLowercaseString(action.type) !== "callback"
      ? undefined
      : (action ?? record);
  const value = normalizeOptionalString(target?.value);
  if (!value) {
    return control;
  }
  const stamped = { ...target, value: stampAgentControlValue(value) };
  return action ? { ...record, action: stamped } : stamped;
}

/** Marks one callback value as the conversation agent's. */
export function stampAgentControlValue(value: string): string {
  return `${AGENT_CONTROL_MARK}${value}`;
}

function stampAgentControlBlock(block: unknown): unknown {
  const record = toRecord(block);
  const key = Array.isArray(record?.buttons) ? "buttons" : "options";
  const controls = record?.[key];
  return Array.isArray(controls) ? { ...record, [key]: controls.map(stampAgentControl) } : block;
}

/**
 * Marks message-action callback values as the conversation agent's. Call it only where
 * controls leave core for a channel, which a delivery reaches exactly once.
 */
export function stampAgentControls(payload: Record<string, unknown>): Record<string, unknown> {
  const stamped = { ...payload };
  for (const key of ["presentation", "interactive"] as const) {
    const container = toRecord(payload[key]);
    if (Array.isArray(container?.blocks)) {
      stamped[key] = { ...container, blocks: container.blocks.map(stampAgentControlBlock) };
    }
  }
  return stamped;
}

/** The value behind a tapped agent-authored control, without its mark; undefined otherwise. */
export function agentControlValue(data: unknown): string | undefined {
  const value = typeof data === "string" ? data.trim() : "";
  return value.length > AGENT_CONTROL_MARK.length && value.startsWith(AGENT_CONTROL_MARK)
    ? value.slice(AGENT_CONTROL_MARK.length)
    : undefined;
}

/** The agent input for a tapped agent-authored control; undefined otherwise. */
export function agentControlText(data: unknown): string | undefined {
  const value = agentControlValue(data);
  return value === undefined ? undefined : `callback_data: ${value}`;
}
