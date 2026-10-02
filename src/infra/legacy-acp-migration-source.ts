import { createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { stableStringify } from "@openclaw/normalization-core";
import { z } from "zod";
import type { SessionAcpMeta, SessionEntry } from "../config/sessions/types.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";

const RECEIPT_KIND = "deferred-plugin-acp-metadata";

export const legacyAcpMigrationSourceSchema = z.object({
  sourcePath: z.string(),
  sourceSessionKey: z.string(),
  sessionId: z.string().optional(),
  lifecycleRevision: z.string().optional(),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sourceSizeBytes: z.number().int().nonnegative(),
});

export type LegacyAcpMigrationSource = z.infer<typeof legacyAcpMigrationSourceSchema>;

function sourceBinding(
  source: Pick<LegacyAcpMigrationSource, "sourceSessionKey" | "sessionId" | "lifecycleRevision">,
) {
  return {
    sessionKey: source.sourceSessionKey.trim(),
    sessionBinding: source.lifecycleRevision ?? source.sessionId ?? null,
  };
}

export function legacyAcpMigrationSourceKey(source: LegacyAcpMigrationSource): string {
  return resolveLegacyMigrationSourceKey(
    RECEIPT_KIND,
    source.sourcePath,
    stableStringify(sourceBinding(source)),
  );
}

export function prepareLegacyAcpMigrationSource(params: {
  sourcePath: string;
  sourceSessionKey: string;
  sessionId?: string;
  lifecycleRevision?: string;
  meta: SessionAcpMeta;
}): LegacyAcpMigrationSource {
  const serialized = stableStringify({ ...sourceBinding(params), meta: params.meta });
  return {
    sourcePath: path.resolve(params.sourcePath),
    sourceSessionKey: params.sourceSessionKey.trim(),
    ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
    ...(params.lifecycleRevision !== undefined
      ? { lifecycleRevision: params.lifecycleRevision }
      : {}),
    sourceSha256: createHash("sha256").update(serialized).digest("hex"),
    sourceSizeBytes: Buffer.byteLength(serialized),
  };
}

export function legacyAcpMigrationBindingMatches(
  source: Pick<LegacyAcpMigrationSource, "sessionId" | "lifecycleRevision">,
  entry: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined,
): boolean {
  return (
    entry !== undefined &&
    entry.lifecycleRevision === source.lifecycleRevision &&
    (source.lifecycleRevision !== undefined || entry.sessionId === source.sessionId)
  );
}

export function hasLegacyAcpMigrationCompletion(
  database: DatabaseSync,
  source: LegacyAcpMigrationSource,
): boolean {
  const receipt = readLegacyMigrationReceiptFromDatabase(
    database,
    legacyAcpMigrationSourceKey(source),
  );
  if (!receipt) {
    return false;
  }
  if (receipt.sourceSha256 !== source.sourceSha256) {
    throw new Error(
      `Retained ACP metadata changed after import in ${source.sourcePath}; resolve the source conflict before rerunning Doctor. Canonical metadata was not replayed.`,
    );
  }
  return true;
}

/** Canonical supersession and legacy import consume the same source component. */
export function recordLegacyAcpMigrationCompletion(
  database: DatabaseSync,
  source: LegacyAcpMigrationSource,
  now: number,
): void {
  if (hasLegacyAcpMigrationCompletion(database, source)) {
    return;
  }
  const sourceKey = legacyAcpMigrationSourceKey(source);
  recordLegacyMigrationReceipt(database, {
    sourceKey,
    migrationKind: RECEIPT_KIND,
    sourcePath: source.sourcePath,
    targetTable: "acp_sessions",
    sourceSha256: source.sourceSha256,
    sourceSizeBytes: source.sourceSizeBytes,
    sourceRecordCount: 1,
    runId: sourceKey,
    reportJson: "{}",
    now,
  });
}
