import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow } from "../api/types.ts";
import { resolveSessionTitleText } from "./session-display.ts";
import { isDashboardSessionKey } from "./sessions/session-key.ts";

export function resolveSessionRenameValue(
  row: Pick<GatewaySessionRow, "key" | "label" | "displayName" | "derivedTitle" | "titlePending">,
): string {
  // Dashboard titles are editable session text; channel/account decoration is not.
  return (
    (isDashboardSessionKey(row.key)
      ? resolveSessionTitleText(row.key, row)
      : normalizeOptionalString(row.label)) ?? ""
  );
}

export function resolveSessionRenamePatch(
  value: string,
  initialValue: string,
  storedLabel: string | undefined,
): { label: string | null } | null {
  const label = normalizeOptionalString(value) ?? null;
  // Merely accepting a generated title must not freeze it as a manual label.
  return label === (normalizeOptionalString(initialValue) ?? null) ||
    label === (normalizeOptionalString(storedLabel) ?? null)
    ? null
    : { label };
}
