import { createHash } from "node:crypto";
import type { LegacyAuditFileCheckpoint } from "./state-migrations.audit-checkpoints.js";

type AuditRecoveryRestoreJournal = {
  schemaVersion: 6 | 7;
  rawBase64: string;
  scrubPatternBase64: string;
  target: Pick<LegacyAuditFileCheckpoint, "dev" | "ino" | "size">;
};

export type ParsedAuditRecoveryRestoreJournal = {
  sourceRaw: Buffer;
  scrubPattern: Buffer;
  target: AuditRecoveryRestoreJournal["target"];
  journalHash: string;
};

export type AuditRecoveryProgress = {
  schemaVersion: 1;
  journalHash: string;
  direction: "restoring" | "scrubbing";
  committedBytes: number;
  pendingEnd: number;
  extentBytes: number;
};

const AUDIT_RECOVERY_SCRUB_PATTERN_BYTES = 32;

export function serializeAuditRecoveryRestoreJournal(params: {
  rawBytes: Buffer;
  scrubPattern: Buffer;
  target: AuditRecoveryRestoreJournal["target"];
}): string {
  if (!isExactJournalIdentity(params.target.dev) || !isExactJournalIdentity(params.target.ino)) {
    throw new Error("invalid legacy audit recovery restore identity");
  }
  const journal: AuditRecoveryRestoreJournal = {
    schemaVersion: 7,
    rawBase64: params.rawBytes.toString("base64"),
    scrubPatternBase64: params.scrubPattern.toString("base64"),
    target: params.target,
  };
  return `${JSON.stringify(journal)}\n`;
}

function isExactJournalIdentity(value: unknown): value is string {
  return typeof value === "string" && /^(0|-?[1-9][0-9]*)$/u.test(value);
}

export function parseAuditRecoveryRestoreJournal(raw: string): ParsedAuditRecoveryRestoreJournal {
  const parsed = JSON.parse(raw) as Partial<AuditRecoveryRestoreJournal>;
  const isPersistedIdentity = (value: unknown) =>
    parsed.schemaVersion === 6
      ? typeof value === "number" && Number.isInteger(value)
      : isExactJournalIdentity(value);
  if (
    (parsed.schemaVersion !== 6 && parsed.schemaVersion !== 7) ||
    typeof parsed.rawBase64 !== "string" ||
    typeof parsed.scrubPatternBase64 !== "string" ||
    !parsed.target ||
    !isPersistedIdentity(parsed.target.dev) ||
    !isPersistedIdentity(parsed.target.ino) ||
    typeof parsed.target.size !== "number"
  ) {
    throw new Error("invalid legacy audit recovery restore journal");
  }
  const scrubPattern = Buffer.from(parsed.scrubPatternBase64, "base64");
  if (
    scrubPattern.length !== AUDIT_RECOVERY_SCRUB_PATTERN_BYTES ||
    scrubPattern.some((byte) => byte !== 0x09 && byte !== 0x20)
  ) {
    throw new Error("invalid legacy audit recovery scrub pattern");
  }
  const sourceRaw = Buffer.from(parsed.rawBase64, "base64");
  if (sourceRaw.length !== parsed.target.size) {
    throw new Error("invalid legacy audit recovery source size");
  }
  return {
    sourceRaw,
    scrubPattern,
    target: parsed.target,
    journalHash: createHash("sha256").update(raw).digest("hex"),
  };
}

export function serializeAuditRecoveryProgress(progress: AuditRecoveryProgress): string {
  return `${JSON.stringify(progress)}\n`;
}

export function parseAuditRecoveryProgress(
  raw: string,
  journal: ParsedAuditRecoveryRestoreJournal,
): AuditRecoveryProgress {
  const parsed = JSON.parse(raw) as Partial<AuditRecoveryProgress>;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.journalHash !== journal.journalHash ||
    (parsed.direction !== "restoring" && parsed.direction !== "scrubbing") ||
    !Number.isSafeInteger(parsed.committedBytes) ||
    !Number.isSafeInteger(parsed.pendingEnd) ||
    !Number.isSafeInteger(parsed.extentBytes) ||
    parsed.committedBytes! < 0 ||
    parsed.pendingEnd! < parsed.committedBytes! ||
    parsed.extentBytes! < parsed.pendingEnd! ||
    parsed.extentBytes! > journal.target.size ||
    (parsed.direction === "scrubbing" && parsed.extentBytes !== journal.target.size)
  ) {
    throw new Error("invalid legacy audit recovery progress");
  }
  return parsed as AuditRecoveryProgress;
}

function auditRecoveryTransitionMatches(
  current: Buffer,
  previous: Buffer,
  desired: Buffer,
  start: number,
  end: number,
): boolean {
  let boundary = start;
  while (boundary < end && current[boundary] === desired[boundary]) {
    boundary += 1;
  }
  return current.subarray(boundary, end).equals(previous.subarray(boundary, end));
}

export function auditRecoveryStateMatchesJournal(params: {
  current: Buffer;
  original: Buffer;
  scrubbed: Buffer;
  progress: AuditRecoveryProgress;
}): boolean {
  const { current, original, scrubbed, progress } = params;
  if (current.length < original.length) {
    return false;
  }
  const scrubbing = progress.direction === "scrubbing";
  const desired = scrubbing ? scrubbed : original;
  const previous = scrubbing ? original : scrubbed;
  const previousEnd = scrubbing ? original.length : progress.extentBytes;
  return (
    current
      .subarray(0, progress.committedBytes)
      .equals(desired.subarray(0, progress.committedBytes)) &&
    auditRecoveryTransitionMatches(
      current,
      previous,
      desired,
      progress.committedBytes,
      progress.pendingEnd,
    ) &&
    current
      .subarray(progress.pendingEnd, previousEnd)
      .equals(previous.subarray(progress.pendingEnd, previousEnd)) &&
    (scrubbing ||
      current
        .subarray(progress.extentBytes, original.length)
        .equals(original.subarray(progress.extentBytes)))
  );
}
