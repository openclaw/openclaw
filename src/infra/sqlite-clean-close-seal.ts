import { createHash } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasErrnoCode } from "./errno.js";
import { readDatabaseIdentityBirthtime } from "./sqlite-worker-identity.js";

const fullVerificationIntervalMs = 7 * 24 * 60 * 60 * 1_000;

export type SqliteCleanCloseSealRefusal =
  | "no-proof"
  | "malformed-proof"
  | "expired-proof"
  | "file-mismatch"
  | "journal-present"
  | "identity-mismatch"
  | "runtime-mismatch"
  | "sqlite-mismatch"
  | "schema-mismatch"
  | "policy-mismatch";

type SealProof = { verifiedAt: number; facts: unknown; identity?: unknown };

function fileFields(file: BigIntStats) {
  return {
    dev: file.dev.toString(),
    ino: file.ino.toString(),
    birthtime: readDatabaseIdentityBirthtime(file),
    size: file.size.toString(),
    mtimeNs: file.mtimeNs.toString(),
  };
}

function checksum(payload: string): string {
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function hasNoJournal(pathname: string): boolean {
  return ["-wal", "-journal"].every((suffix) => {
    try {
      const file = fs.statSync(`${pathname}${suffix}`, { bigint: true });
      return file.isFile() && file.size === 0n;
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return true;
      }
      throw error;
    }
  });
}

/** The caller supplies fstat from its retained descriptor; closing a new one can release SQLite locks. */
export function readSqliteCleanCloseSeal(
  pathname: string,
  file: BigIntStats,
  onRefusal?: (reason: SqliteCleanCloseSealRefusal) => void,
): (SealProof & { schemaIdentity: string }) | undefined {
  const refuse = (reason: SqliteCleanCloseSealRefusal) => {
    onRefusal?.(reason);
    return undefined;
  };
  try {
    const sealPath = `${pathname}.seal`;
    if (!fs.lstatSync(sealPath).isFile()) {
      return refuse("malformed-proof");
    }
    const envelope: unknown = JSON.parse(fs.readFileSync(sealPath, "utf8"));
    if (
      !isRecord(envelope) ||
      typeof envelope.payload !== "string" ||
      envelope.checksum !== checksum(envelope.payload)
    ) {
      return refuse("malformed-proof");
    }
    const payload: unknown = JSON.parse(envelope.payload);
    if (
      !isRecord(payload) ||
      payload.version !== 1 ||
      typeof payload.schemaIdentity !== "string" ||
      typeof payload.verifiedAt !== "number" ||
      !Number.isSafeInteger(payload.verifiedAt) ||
      !("facts" in payload) ||
      !file.isFile()
    ) {
      return refuse("malformed-proof");
    }
    const age = Date.now() - payload.verifiedAt;
    if (age < 0 || age > fullVerificationIntervalMs) {
      return refuse("expired-proof");
    }
    if (!Object.entries(fileFields(file)).every(([key, value]) => payload[key] === value)) {
      return refuse("file-mismatch");
    }
    if (!hasNoJournal(pathname)) {
      return refuse("journal-present");
    }
    return {
      schemaIdentity: payload.schemaIdentity,
      verifiedAt: payload.verifiedAt,
      facts: payload.facts,
      ...(payload.identity === undefined ? {} : { identity: payload.identity }),
    };
  } catch (error) {
    // Torn writes and unreadable seals fall back to the ordinary full validation.
    return refuse(hasErrnoCode(error, "ENOENT") ? "no-proof" : "malformed-proof");
  }
}

export function invalidateSqliteCleanCloseSeal(pathname: string): void {
  try {
    fs.unlinkSync(`${pathname}.seal`);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
}

export function writeSqliteCleanCloseSeal(
  pathname: string,
  schemaIdentity: string,
  file: BigIntStats,
  proof: SealProof,
): boolean {
  try {
    const sealPath = `${pathname}.seal`;
    const existing = fs.lstatSync(sealPath, { throwIfNoEntry: false });
    if (!file.isFile() || (existing && !existing.isFile()) || !hasNoJournal(pathname)) {
      invalidateSqliteCleanCloseSeal(pathname);
      return false;
    }
    const payload = JSON.stringify({
      version: 1,
      schemaIdentity,
      ...fileFields(file),
      verifiedAt: proof.verifiedAt,
      facts: proof.facts,
      identity: proof.identity,
    });
    // No rename/fsync is needed: a partial write cannot pass the checksum and file-state checks.
    fs.writeFileSync(sealPath, JSON.stringify({ payload, checksum: checksum(payload) }));
    return true;
  } catch {
    try {
      invalidateSqliteCleanCloseSeal(pathname);
    } catch {
      // Publication is best effort; failed invalidation still cannot authorize a write.
    }
    return false;
  }
}
