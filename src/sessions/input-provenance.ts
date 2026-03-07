import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const INPUT_PROVENANCE_KIND_VALUES = [
  "external_user",
  "inter_session",
  "internal_system",
] as const;

export type InputProvenanceKind = (typeof INPUT_PROVENANCE_KIND_VALUES)[number];

export type InputProvenance = {
  kind: InputProvenanceKind;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
};

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

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
  return {
    kind: record.kind,
    sourceSessionKey: normalizeOptionalString(record.sourceSessionKey),
    sourceChannel: normalizeOptionalString(record.sourceChannel),
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

  // Inter-session user messages are rewritten to role:"assistant" so the model
  // does not treat forwarded cross-session content as its own prior output.
  // Only rewrite user messages; toolResult and other role types must be preserved
  // so downstream repair/sanitization logic is not skipped.
  if (isInterSessionInputProvenance(inputProvenance)) {
    if ((message as { role?: unknown }).role !== "user") {
      return message;
    }
    return {
      ...(message as unknown as Record<string, unknown>),
      role: "assistant",
      provenance: inputProvenance,
    } as unknown as AgentMessage;
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
  if (!message) {
    return false;
  }
  // Inter-session user messages are rewritten to role:"assistant" by
  // applyInputProvenanceToUserMessage, so accept both roles here so that
  // provenance-based filters (e.g. session-memory hook) still work correctly.
  const role = message.role;
  if (role !== "user" && role !== "assistant") {
    return false;
  }
  return isInterSessionInputProvenance(message.provenance);
}
