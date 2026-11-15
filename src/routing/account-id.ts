import { normalizeAgentIdStrict } from "@openclaw/normalization-core/agent-id";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";

export const DEFAULT_ACCOUNT_ID = "default";

// Account ids are config/session keys, not display names. Normalize them into
// short lowercase safe keys and reject prototype-like object keys.
export function normalizeAccountId(value: string | undefined | null): string {
  return normalizeOptionalAccountId(value) ?? DEFAULT_ACCOUNT_ID;
}

// Optional variant for config fields where absence is meaningful. Invalid ids
// return undefined instead of silently selecting the default account.
export function normalizeOptionalAccountId(value: string | undefined | null): string | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  const canonical = normalizeAgentIdStrict(trimmed);
  return canonical.ok && !isBlockedObjectKey(canonical.value) ? canonical.value : undefined;
}
