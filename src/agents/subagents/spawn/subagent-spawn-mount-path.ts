import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasPromptUnsafeControlCharacter } from "../../sanitize-for-prompt.js";

export function sanitizeSubagentMountPathHint(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed || hasPromptUnsafeControlCharacter(trimmed)) {
    return undefined;
  }
  return /^[A-Za-z0-9._\-/:]+$/.test(trimmed) ? trimmed : undefined;
}
