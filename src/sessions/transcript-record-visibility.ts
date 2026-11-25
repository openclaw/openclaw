import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { RUNTIME_CONTEXT_CUSTOM_TYPE } from "../llm/types.js";

export function isVisibleTranscriptRecord(value: unknown): value is Record<string, unknown> {
  const record = asOptionalRecord(value);
  return (
    Boolean(record?.message) ||
    record?.type === "compaction" ||
    record?.type === "reset" ||
    (record?.type === "custom_message" &&
      record.display === true &&
      record.customType !== RUNTIME_CONTEXT_CUSTOM_TYPE)
  );
}
