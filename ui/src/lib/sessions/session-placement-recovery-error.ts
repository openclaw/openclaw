import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

export const SESSION_PLACEMENT_ERROR_MAX_LENGTH = 4096;

// Keep this projection free of storage validators: the lazy startup shell uses it too.
export function formatSessionPlacementRecoveryError(recovery: {
  error: string;
  sendError?: string;
}): string {
  if (!recovery.sendError || recovery.sendError === recovery.error) {
    return recovery.error;
  }
  // Reserve space for both diagnostics without accumulating previous checks.
  return `${truncateUtf16Safe(recovery.sendError, SESSION_PLACEMENT_ERROR_MAX_LENGTH / 2)}\n\n${truncateUtf16Safe(recovery.error, SESSION_PLACEMENT_ERROR_MAX_LENGTH / 2 - 2)}`;
}
