import { normalizeOptionalStringifiedId } from "../../shared/string-coerce.js";

export function normalizeOutboundThreadId(value?: string | number | null): string | undefined {
  return normalizeOptionalStringifiedId(value);
}
