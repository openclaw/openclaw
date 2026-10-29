import type { DatabaseSync } from "node:sqlite";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import { sql, type RawBuilder } from "kysely";
import { getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";

const MAX_COMPRESSED_TRAJECTORY_EVENT_BYTES = 256 * 1024;
const MIN_COMPRESS_BYTES = 1024;
const BROTLI_CODEC = "br";
const DECODE_FUNCTION = "openclaw_trajectory_payload_decode";
const registeredDecoders = new WeakSet<DatabaseSync>();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type TrajectoryPayloadRecord = {
  event_json: string;
  event_payload: Uint8Array | null;
  event_codec: string | null;
  event_utf8_bytes: number | null;
};

export function readTrajectoryStorageEncoding(database: EngineConnection): string {
  if (isPostgresSqlConnection(database)) {
    return "UTF-8";
  }
  const facts = getAdmittedSqliteSchemaFacts(database);
  if (!facts) {
    throw new Error("Trajectory payload preparation requires admitted SQLite schema facts");
  }
  return facts.textEncoding;
}

/** Prepare exact event bytes before entering the trajectory writer transaction. */
export function prepareTrajectoryPayload(
  database: EngineConnection,
  eventJson: string,
  storageEncoding = readTrajectoryStorageEncoding(database),
): TrajectoryPayloadRecord {
  const rawBytes = Buffer.byteLength(eventJson, "utf8");
  const utf8 = storageEncoding === "UTF-8";
  const raw: TrajectoryPayloadRecord = {
    event_json: eventJson,
    event_payload: null,
    event_codec: null,
    event_utf8_bytes: utf8 ? rawBytes : null,
  };
  // PostgreSQL owns physical compression through TOAST; UTF-16 retains native byte accounting.
  if (
    isPostgresSqlConnection(database) ||
    !utf8 ||
    rawBytes < MIN_COMPRESS_BYTES ||
    rawBytes > MAX_COMPRESSED_TRAJECTORY_EVENT_BYTES ||
    !eventJson.isWellFormed()
  ) {
    return raw;
  }
  const payload = brotliCompressSync(eventJson, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 3,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_LGWIN]: 18,
    },
  });
  if (payload.byteLength > rawBytes - Math.max(64, Math.ceil(rawBytes / 10))) {
    return raw;
  }
  return { ...raw, event_json: "", event_payload: payload, event_codec: BROTLI_CODEC };
}

function decodePayload(bytes: unknown, codec: unknown, rawBytes: unknown): string {
  if (codec !== BROTLI_CODEC) {
    throw new Error(`Unsupported trajectory payload codec: ${String(codec)}`);
  }
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_COMPRESSED_TRAJECTORY_EVENT_BYTES ||
    typeof rawBytes !== "number" ||
    !Number.isSafeInteger(rawBytes) ||
    rawBytes < 1 ||
    rawBytes > MAX_COMPRESSED_TRAJECTORY_EVENT_BYTES
  ) {
    throw new Error("Invalid compressed trajectory payload bounds");
  }
  const decoded = brotliDecompressSync(bytes, { maxOutputLength: rawBytes });
  if (decoded.byteLength !== rawBytes) {
    throw new Error("Compressed trajectory payload length does not match its recorded UTF-8 size");
  }
  return utf8Decoder.decode(decoded);
}

/** Legacy rows retain their original TEXT; new rows decode without JSON reserialization. */
export function readTrajectoryPayload(row: TrajectoryPayloadRecord): string {
  return row.event_codec === null
    ? row.event_json
    : decodePayload(row.event_payload, row.event_codec, row.event_utf8_bytes);
}

/** Keep narrow diagnostic projections in SQL instead of transferring expanded event bodies. */
export function trajectoryEventJsonSql(
  database: EngineConnection,
  alias: "trajectory_runtime_events" | "event" | "te" = "trajectory_runtime_events",
): RawBuilder<string> {
  const identity =
    /* kysely-allow-raw: closed trajectory aliases identify the original event text. */ sql.ref<string>(
      `${alias}.event_json`,
    );
  if (isPostgresSqlConnection(database)) {
    return identity;
  }
  if (!registeredDecoders.has(database)) {
    database.function(DECODE_FUNCTION, { deterministic: true, directOnly: true }, decodePayload);
    registeredDecoders.add(database);
  }
  const payload =
    /* kysely-allow-raw: closed trajectory aliases identify the compressed bytes. */ sql.ref(
      `${alias}.event_payload`,
    );
  const codec =
    /* kysely-allow-raw: closed trajectory aliases identify the per-row codec. */ sql.ref(
      `${alias}.event_codec`,
    );
  const bytes =
    /* kysely-allow-raw: closed trajectory aliases identify the logical byte length. */ sql.ref(
      `${alias}.event_utf8_bytes`,
    );
  const decode = getNodeSqliteKysely<Record<string, never>>(database).fn<string>(DECODE_FUNCTION, [
    payload,
    codec,
    bytes,
  ]);
  return /* kysely-allow-raw: lazy selection keeps legacy TEXT out of the bounded decoder. */ sql<string>`CASE WHEN ${codec} IS NULL THEN ${identity} ELSE ${decode} END`;
}
