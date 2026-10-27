import type { DatabaseSync } from "node:sqlite";
import { sql, type RawBuilder } from "kysely";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";

export const MAX_COMPRESSED_EVENT_BYTES = 4 * 1024 * 1024;
export type TranscriptPayloadAlias = "transcript_events" | "event" | "te" | "parent";
const DECODE_FUNCTION = "openclaw_transcript_payload_decode";
const registeredDecoders = new WeakSet<DatabaseSync>();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function registerDecoder(database: DatabaseSync): void {
  if (registeredDecoders.has(database)) {
    return;
  }
  database.function(
    DECODE_FUNCTION,
    { deterministic: true, directOnly: true },
    decodeCompressedTranscriptPayload,
  );
  registeredDecoders.add(database);
}

function decodeCompressedTranscriptPayload(bytes: unknown, rawBytes: unknown): string {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_COMPRESSED_EVENT_BYTES ||
    typeof rawBytes !== "number" ||
    !Number.isSafeInteger(rawBytes) ||
    rawBytes < 1 ||
    rawBytes > MAX_COMPRESSED_EVENT_BYTES
  ) {
    throw new Error("Invalid compressed transcript payload bounds");
  }
  const codec = resolveZstdCodec();
  const decoded = codec.decompress(bytes, rawBytes);
  if (decoded.byteLength !== rawBytes) {
    throw new Error("Compressed transcript payload length does not match its recorded UTF-8 size");
  }
  return utf8Decoder.decode(decoded);
}

/** Decode selected rows without copying expanded payloads back through SQLite. */
export function readTranscriptPayload(row: {
  event_json: string | null;
  event_zstd: Uint8Array | null;
  event_utf8_bytes: number | null;
}): string {
  return row.event_json ?? decodeCompressedTranscriptPayload(row.event_zstd, row.event_utf8_bytes);
}

/** Only selected bodies decode; identity TEXT remains inside SQLite for native repairs. */
export function transcriptEventJsonSql(
  database: EngineConnection,
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<string> {
  if (isPostgresSqlConnection(database)) {
    return /* kysely-allow-raw: closed transcript aliases select PostgreSQL's canonical text. */ sql.ref<string>(
      `${alias}.event_json`,
    );
  }
  registerDecoder(database);
  const identity =
    /* kysely-allow-raw: closed transcript aliases select the canonical identity column. */ sql.ref(
      `${alias}.event_json`,
    );
  const compressed =
    /* kysely-allow-raw: closed transcript aliases select the canonical compressed column. */ sql.ref(
      `${alias}.event_zstd`,
    );
  const bytes =
    /* kysely-allow-raw: closed transcript aliases select recorded canonical byte counts. */ sql.ref(
      `${alias}.event_utf8_bytes`,
    );
  const decode = getNodeSqliteKysely<Record<string, never>>(database).fn<string>(DECODE_FUNCTION, [
    compressed,
    bytes,
  ]);
  return /* kysely-allow-raw: lazy selection evaluates identity expressions once and keeps giant TEXT out of the bounded JS decoder. */ sql<string>`coalesce(${identity}, ${decode})`;
}
