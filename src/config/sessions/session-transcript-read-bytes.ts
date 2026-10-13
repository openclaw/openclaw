import { sql, type RawBuilder } from "kysely";
import { transcriptEventUtf8BytesSql, type TranscriptPayloadAlias } from "./transcript-payload.js";

/** Preserve native identity accounting where a legacy row has no exact UTF-8 size. */
export function transcriptEventReadBytesSql(
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<number> {
  const identity =
    /* kysely-allow-raw: closed transcript aliases select the canonical identity column. */ sql.ref(
      `${alias}.event_json`,
    );
  return /* kysely-allow-raw: recorded uncompressed bytes or native identity column metadata preserve existing byte budgets. */ sql<number>`coalesce(${transcriptEventUtf8BytesSql(alias)}, octet_length(${identity}))`;
}
