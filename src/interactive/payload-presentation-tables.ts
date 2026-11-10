import { asOptionalRecord as toRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";

/**
 * Reject captionless table blocks before normalization drops them.
 * Table normalization is atomic and drops invalid tables instead of
 * repairing them, so a send boundary must fail loudly here rather than
 * deliver a message with the table silently missing.
 */
export function assertMessagePresentationTablesHaveCaptions(raw: unknown): void {
  const record = toRecord(raw);
  const blocks = record && Array.isArray(record.blocks) ? record.blocks : [];
  for (const block of blocks) {
    const table = toRecord(block);
    if (!table || normalizeOptionalLowercaseString(table.type) !== "table") {
      continue;
    }
    if (normalizeOptionalString(table.caption)) {
      continue;
    }
    throw new Error(
      "Table blocks require a caption. Add a short caption describing the table and retry the send.",
    );
  }
}
