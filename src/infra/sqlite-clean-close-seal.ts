import { createHash } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import { hasErrnoCode } from "./errno.js";
import { readDatabaseIdentityBirthtime } from "./sqlite-worker-identity.js";

const fullVerificationIntervalMs = 7 * 24 * 60 * 60 * 1_000;

type SealProof = { verifiedAt: number; facts: unknown };

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
  schemaIdentity: string,
  file: BigIntStats,
): SealProof | undefined {
  try {
    const sealPath = `${pathname}.seal`;
    if (!fs.lstatSync(sealPath).isFile()) {
      return undefined;
    }
    const envelope: unknown = JSON.parse(fs.readFileSync(sealPath, "utf8"));
    if (
      !envelope ||
      typeof envelope !== "object" ||
      !("payload" in envelope) ||
      typeof envelope.payload !== "string" ||
      !("checksum" in envelope) ||
      envelope.checksum !== checksum(envelope.payload)
    ) {
      return undefined;
    }
    const payload: unknown = JSON.parse(envelope.payload);
    if (
      !payload ||
      typeof payload !== "object" ||
      !("version" in payload) ||
      payload.version !== 1 ||
      !("schemaIdentity" in payload) ||
      payload.schemaIdentity !== schemaIdentity ||
      !("verifiedAt" in payload) ||
      typeof payload.verifiedAt !== "number" ||
      !Number.isSafeInteger(payload.verifiedAt) ||
      !("facts" in payload) ||
      !file.isFile()
    ) {
      return undefined;
    }
    const age = Date.now() - payload.verifiedAt;
    if (
      age < 0 ||
      age > fullVerificationIntervalMs ||
      !Object.entries(fileFields(file)).every(
        ([key, value]) => key in payload && Reflect.get(payload, key) === value,
      ) ||
      !hasNoJournal(pathname)
    ) {
      return undefined;
    }
    return { verifiedAt: payload.verifiedAt, facts: payload.facts };
  } catch {
    // Torn writes and unreadable seals fall back to the ordinary full validation.
    return undefined;
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
