/** Connection-bound hosted catalog snapshot SQL and monotonicity checks. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  HostedCatalogSignedFeedMonotonicityError,
  isOfficialExternalPluginCatalogSequence,
  parseOfficialExternalPluginCatalogTimestamp,
} from "./official-external-plugin-catalog-source.js";
import type {
  HostedOfficialExternalPluginCatalogMetadata,
  HostedOfficialExternalPluginCatalogSnapshot,
  HostedOfficialExternalPluginCatalogSnapshotMonotonicState,
  HostedOfficialExternalPluginCatalogTrustState,
} from "./official-external-plugin-catalog.types.js";

type HostedCatalogSnapshotRow = {
  feed_url: string;
  body: string;
  status: number | bigint;
  etag: string | null;
  last_modified: string | null;
  checksum: string;
  saved_at: string;
  trust_mode: string | null;
  trust_key_id: string | null;
  trust_signature_count: number | bigint | null;
  trust_threshold: number | bigint | null;
  trust_verified_at: string | null;
};

type HostedCatalogSnapshotDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "official_external_plugin_catalog_snapshots"
>;

type StoredHostedCatalogMonotonicState = {
  sequence: number;
  generatedAt?: string;
  payloadSha256: string;
};

function rowToTrustState(
  row: HostedCatalogSnapshotRow,
): HostedOfficialExternalPluginCatalogTrustState | undefined {
  if (
    row.trust_mode !== "signed" ||
    !row.trust_key_id ||
    row.trust_signature_count === null ||
    row.trust_threshold === null ||
    !row.trust_verified_at
  ) {
    return undefined;
  }
  return {
    mode: "signed",
    signedBy: row.trust_key_id,
    signatureCount: sqliteNumber(row.trust_signature_count),
    threshold: sqliteNumber(row.trust_threshold),
    verifiedAt: row.trust_verified_at,
  };
}

function decodeBase64Payload(payload: string): string {
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function readMonotonicStateFromBody(body: string): StoredHostedCatalogMonotonicState | undefined {
  try {
    const document: unknown = JSON.parse(body);
    if (!isRecord(document)) {
      return undefined;
    }
    const payload =
      typeof document.payload === "string" ? decodeBase64Payload(document.payload) : body;
    const feed: unknown = typeof document.payload === "string" ? JSON.parse(payload) : document;
    if (!isRecord(feed) || !isOfficialExternalPluginCatalogSequence(feed.sequence)) {
      return undefined;
    }
    if (
      typeof feed.generatedAt !== "string" ||
      parseOfficialExternalPluginCatalogTimestamp(feed.generatedAt) === undefined
    ) {
      return {
        sequence: feed.sequence,
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
      };
    }
    return {
      sequence: feed.sequence,
      generatedAt: feed.generatedAt,
      payloadSha256: createHash("sha256").update(payload).digest("hex"),
    };
  } catch {
    return undefined;
  }
}

function isMonotonicRollback(params: {
  candidate: HostedOfficialExternalPluginCatalogSnapshotMonotonicState;
  current: StoredHostedCatalogMonotonicState;
}): boolean {
  if (params.candidate.sequence < params.current.sequence) {
    return true;
  }
  if (params.candidate.sequence > params.current.sequence) {
    return false;
  }
  if (params.candidate.generatedAt === undefined || params.current.generatedAt === undefined) {
    return false;
  }
  return Date.parse(params.candidate.generatedAt) < Date.parse(params.current.generatedAt);
}

function assertSignedSnapshotWriteIsMonotonic(params: {
  candidate: HostedOfficialExternalPluginCatalogSnapshotMonotonicState | undefined;
  candidateBody: string;
  current: HostedCatalogSnapshotRow | undefined;
}): void {
  if (params.candidate?.mode !== "signed-feed" || params.current?.trust_mode !== "signed") {
    return;
  }
  const current = readMonotonicStateFromBody(params.current.body);
  if (!current) {
    return;
  }
  if (isMonotonicRollback({ candidate: params.candidate, current })) {
    throw new HostedCatalogSignedFeedMonotonicityError(
      "hosted catalog signed feed sequence is older than current snapshot",
    );
  }
  if (params.candidate.sequence !== current.sequence || current.generatedAt === undefined) {
    return;
  }
  const candidate = readMonotonicStateFromBody(params.candidateBody);
  if (
    candidate?.sequence === params.candidate.sequence &&
    candidate.payloadSha256 !== current.payloadSha256
  ) {
    throw new HostedCatalogSignedFeedMonotonicityError(
      "hosted catalog signed feed payload changed without a sequence increment",
    );
  }
}

function rowToSnapshot(
  row: HostedCatalogSnapshotRow | undefined,
): HostedOfficialExternalPluginCatalogSnapshot | null {
  if (!row) {
    return null;
  }
  const metadata: HostedOfficialExternalPluginCatalogMetadata = {
    url: row.feed_url,
    status: sqliteNumber(row.status),
    checksum: row.checksum,
    ...(row.etag ? { etag: row.etag } : {}),
    ...(row.last_modified ? { lastModified: row.last_modified } : {}),
  };
  const trust = rowToTrustState(row);
  const storedMonotonic = trust ? readMonotonicStateFromBody(row.body) : undefined;
  const monotonic = storedMonotonic
    ? {
        mode: "signed-feed" as const,
        sequence: storedMonotonic.sequence,
        ...(storedMonotonic.generatedAt ? { generatedAt: storedMonotonic.generatedAt } : {}),
      }
    : undefined;
  return {
    body: row.body,
    metadata,
    savedAt: row.saved_at,
    ...(trust ? { trust } : {}),
    ...(monotonic ? { monotonic } : {}),
  };
}

export function readHostedCatalogSnapshotInDatabase(
  db: DatabaseSync,
  url: string,
): HostedOfficialExternalPluginCatalogSnapshot | null {
  const stateDb = getNodeSqliteKysely<HostedCatalogSnapshotDatabase>(db);
  const row: HostedCatalogSnapshotRow | undefined = executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("official_external_plugin_catalog_snapshots")
      .select([
        "feed_url",
        "body",
        "status",
        "etag",
        "last_modified",
        "checksum",
        "saved_at",
        "trust_mode",
        "trust_key_id",
        "trust_signature_count",
        "trust_threshold",
        "trust_verified_at",
      ])
      .where("feed_url", "=", url),
  );
  return rowToSnapshot(row);
}

/** The caller owns the write transaction containing the reread and upsert. */
export function writeHostedCatalogSnapshotInDatabase(
  db: DatabaseSync,
  snapshot: HostedOfficialExternalPluginCatalogSnapshot,
  now: number,
): void {
  const stateDb = getNodeSqliteKysely<HostedCatalogSnapshotDatabase>(db);
  const current: HostedCatalogSnapshotRow | undefined = executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("official_external_plugin_catalog_snapshots")
      .select([
        "feed_url",
        "body",
        "status",
        "etag",
        "last_modified",
        "checksum",
        "saved_at",
        "trust_mode",
        "trust_key_id",
        "trust_signature_count",
        "trust_threshold",
        "trust_verified_at",
      ])
      .where("feed_url", "=", snapshot.metadata.url),
  );
  assertSignedSnapshotWriteIsMonotonic({
    candidate: snapshot.monotonic,
    candidateBody: snapshot.body,
    current,
  });
  executeSqliteQuerySync(
    db,
    stateDb
      .insertInto("official_external_plugin_catalog_snapshots")
      .values({
        feed_url: snapshot.metadata.url,
        body: snapshot.body,
        status: snapshot.metadata.status,
        etag: snapshot.metadata.etag ?? null,
        last_modified: snapshot.metadata.lastModified ?? null,
        checksum: snapshot.metadata.checksum,
        saved_at: snapshot.savedAt,
        updated_at_ms: now,
        trust_mode: snapshot.trust?.mode ?? null,
        trust_key_id: snapshot.trust?.signedBy ?? null,
        trust_signature_count: snapshot.trust?.signatureCount ?? null,
        trust_threshold: snapshot.trust?.threshold ?? null,
        trust_verified_at: snapshot.trust?.verifiedAt ?? null,
      })
      .onConflict((conflict) =>
        conflict.column("feed_url").doUpdateSet({
          body: snapshot.body,
          status: snapshot.metadata.status,
          etag: snapshot.metadata.etag ?? null,
          last_modified: snapshot.metadata.lastModified ?? null,
          checksum: snapshot.metadata.checksum,
          saved_at: snapshot.savedAt,
          updated_at_ms: now,
          trust_mode: snapshot.trust?.mode ?? null,
          trust_key_id: snapshot.trust?.signedBy ?? null,
          trust_signature_count: snapshot.trust?.signatureCount ?? null,
          trust_threshold: snapshot.trust?.threshold ?? null,
          trust_verified_at: snapshot.trust?.verifiedAt ?? null,
        }),
      ),
  );
}
