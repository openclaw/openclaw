import { normalizeOptionalString } from "../../shared/string-coerce.js";

export function normalizeOutboundThreadId(value?: string | number | null): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    return String(Math.trunc(value));
  }
  return normalizeOptionalString(value);
}
