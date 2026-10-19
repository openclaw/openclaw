import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export function parseGatewayPayload(value: string | null | undefined): unknown {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { payloadJSON: value };
  }
}
