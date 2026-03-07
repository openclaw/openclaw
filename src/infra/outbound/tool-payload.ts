import type { AgentToolResult } from "@mariozechner/pi-agent-core";

export function extractToolPayload(result: AgentToolResult<unknown>): unknown {
  if (result.details !== undefined) {
    return result.details;
  }
  const textBlock = Array.isArray(result.content)
    ? result.content.find(
        (block) =>
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
    : undefined;
  const text = (textBlock as { text?: string } | undefined)?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result.content ?? result;
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Some channel plugins report failures as structured payloads instead of throwing:
 * `{ status: "error", error: "..." }` or `{ ok: false, message: "..." }`.
 * Surface those as actionable errors so callers don't treat them as successful sends.
 */
export function getToolPayloadError(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (!record) {
    return undefined;
  }
  const status = readStringField(record, "status")?.toLowerCase();
  const statusError = status === "error";
  const explicitNotOk = record.ok === false;
  if (!statusError && !explicitNotOk) {
    return undefined;
  }
  return (
    readStringField(record, "error") ??
    readStringField(record, "message") ??
    (statusError ? "Channel action returned status=error." : "Channel action returned ok=false.")
  );
}
