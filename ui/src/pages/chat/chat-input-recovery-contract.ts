import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeInputProvenance } from "../../../../src/sessions/input-provenance.js";

/** The application preference owner persists opaque, viewer-scoped keys, never payloads. */
export type ChatInputRecoveryDismissals = {
  has: (key: string) => boolean;
  add: (key: string) => boolean;
};

/** Saved agent/system data is not a fresh instruction from the current user. */
export function isChatRecoveryInputSendable(message: unknown): boolean {
  const row = asOptionalRecord(message);
  if (row?.role !== "user") {
    return false;
  }
  const provenance = normalizeInputProvenance(row.provenance);
  return row.provenance == null || provenance?.kind === "external_user";
}
