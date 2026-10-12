import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { AUDIT_EVENT_SCHEMA_VERSION } from "./audit-event-types.js";

type AuditRow = {
  sequence: number | bigint;
  event_id: string;
  source_id: string;
  schema_version: number | bigint;
  source_sequence: number | bigint;
  occurred_at: number | bigint;
  [key: string]: unknown;
};

const AUDIT_HMAC_REF_RE = /^hmac-sha256:v1:[a-f0-9]{32}:[a-f0-9]{64}$/u;

export function corruptAuditRow(row: AuditRow, problem: string): never {
  const sequence = normalizeSqliteNumber(row.sequence);
  const location = sequence === undefined ? "" : ` ${sequence}`;
  throw new Error(`corrupt audit event row${location}: ${problem}`);
}

function requiredInteger(
  row: AuditRow,
  value: number | bigint | null,
  field: string,
  minimum: number,
): number {
  const normalized = normalizeSqliteNumber(value);
  if (normalized === undefined || !Number.isSafeInteger(normalized) || normalized < minimum) {
    corruptAuditRow(row, `invalid ${field}`);
  }
  return normalized;
}

export function optionalInteger(
  row: AuditRow,
  value: number | bigint | null,
  field: string,
  minimum: number,
): number | undefined {
  if (value === null) {
    return undefined;
  }
  return requiredInteger(row, value, field, minimum);
}

export function requiredText(row: AuditRow, value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    corruptAuditRow(row, `invalid ${field}`);
  }
  return value;
}

export function optionalText(row: AuditRow, value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return requiredText(row, value, field);
}

export function requiredEnum<const Value extends string>(
  row: AuditRow,
  value: unknown,
  field: string,
  allowed: readonly Value[],
): Value {
  for (const candidate of allowed) {
    if (value === candidate) {
      return candidate;
    }
  }
  return corruptAuditRow(row, `invalid ${field}`);
}

export function optionalEnum<const Value extends string>(
  row: AuditRow,
  value: unknown,
  field: string,
  allowed: readonly Value[],
): Value | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return requiredEnum(row, value, field, allowed);
}

export function requiredHmacRef(row: AuditRow, value: unknown, field: string): string {
  const text = requiredText(row, value, field);
  if (!AUDIT_HMAC_REF_RE.test(text)) {
    corruptAuditRow(row, `invalid ${field}`);
  }
  return text;
}

export function optionalHmacRef(row: AuditRow, value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return requiredHmacRef(row, value, field);
}

export function requireNull(row: AuditRow, field: string): void {
  if (row[field] !== null) {
    corruptAuditRow(row, `unexpected ${field}`);
  }
}

export function requireNullColumns(row: AuditRow, fields: readonly string[]): void {
  for (const field of fields) {
    requireNull(row, field);
  }
}

export function parseAuditRecordBase(row: AuditRow) {
  const schemaVersion = requiredInteger(row, row.schema_version, "schemaVersion", 1);
  if (schemaVersion !== AUDIT_EVENT_SCHEMA_VERSION) {
    corruptAuditRow(row, `unsupported schemaVersion ${schemaVersion}`);
  }
  return {
    schemaVersion,
    sequence: requiredInteger(row, row.sequence, "sequence", 1),
    eventId: requiredText(row, row.event_id, "eventId"),
    sourceSequence: requiredInteger(row, row.source_sequence, "sourceSequence", 1),
    occurredAt: requiredInteger(row, row.occurred_at, "occurredAt", 0),
    redaction: "metadata_only" as const,
  };
}
