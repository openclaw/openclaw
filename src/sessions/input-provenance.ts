import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export const INPUT_PROVENANCE_KIND_VALUES = [
  "external_user",
  "inter_session",
  "internal_system",
] as const;

export type InputProvenanceKind = (typeof INPUT_PROVENANCE_KIND_VALUES)[number];

export type InputProvenance = {
  kind: InputProvenanceKind;
  originSessionId?: string;
  sourceSessionKey?: string;
  /**
   * The channel where this input originated (Discord, Telegram, Slack, ACP,
   * `webchat` for internal, etc.). Respects origin — not the delivery target.
   * Use this to decide how an inter-session message should be classified or
   * filtered; do not confuse it with the routing/destination channel in
   * `AgentDeliveryPlan.resolvedChannel`.
   */
  originChannel?: string;
  sourceTool?: string;
};

function isInputProvenanceKind(value: unknown): value is InputProvenanceKind {
  return (
    typeof value === "string" && (INPUT_PROVENANCE_KIND_VALUES as readonly string[]).includes(value)
  );
}

export function normalizeInputProvenance(value: unknown): InputProvenance | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!isInputProvenanceKind(record.kind)) {
    return undefined;
  }
  // Accept legacy `sourceChannel` for backward-compat with any persisted
  // provenance or in-flight protocol payloads produced before the
  // `originChannel` rename. Prefer `originChannel` when both are present.
  const originChannel =
    normalizeOptionalString(record.originChannel) ?? normalizeOptionalString(record.sourceChannel);
  return {
    kind: record.kind,
    originSessionId: normalizeOptionalString(record.originSessionId),
    sourceSessionKey: normalizeOptionalString(record.sourceSessionKey),
    originChannel,
    sourceTool: normalizeOptionalString(record.sourceTool),
  };
}

export function applyInputProvenanceToUserMessage(
  message: AgentMessage,
  inputProvenance: InputProvenance | undefined,
): AgentMessage {
  if (!inputProvenance) {
    return message;
  }
  if ((message as { role?: unknown }).role !== "user") {
    return message;
  }
  const existing = normalizeInputProvenance((message as { provenance?: unknown }).provenance);
  if (existing) {
    return message;
  }
  return {
    ...(message as unknown as Record<string, unknown>),
    provenance: inputProvenance,
  } as unknown as AgentMessage;
}

export function isInterSessionInputProvenance(value: unknown): boolean {
  return normalizeInputProvenance(value)?.kind === "inter_session";
}

export function hasInterSessionUserProvenance(
  message: { role?: unknown; provenance?: unknown } | undefined,
): boolean {
  if (!message || message.role !== "user") {
    return false;
  }
  return isInterSessionInputProvenance(message.provenance);
}
