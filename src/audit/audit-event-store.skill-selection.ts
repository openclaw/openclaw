import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import {
  AUDIT_EVENT_SCHEMA_VERSION,
  type SkillSelectionAuditEventRecord,
} from "./audit-event-types.js";

type SkillRow = {
  sequence: number | bigint;
  event_id: string;
  source_id: string;
  schema_version: number | bigint;
  source_sequence: number | bigint;
  tool_name: string | null;
  action: string | null;
  status: string | null;
  actor_type: string | null;
  actor_id: string | null;
  agent_id: string | null;
  session_key: string | null;
  session_id: string | null;
  run_id: string | null;
  occurred_at: number | bigint;
  [key: string]: unknown;
};

function corrupt(problem: string, row: SkillRow): never {
  const sequence = normalizeSqliteNumber(row.sequence);
  const location = sequence === undefined ? "" : ` ${sequence}`;
  throw new Error(`corrupt audit skill-selection row${location}: ${problem}`);
}

function requiredInteger(
  row: SkillRow,
  value: number | bigint | null,
  field: string,
  minimum: number,
): number {
  const normalized = normalizeSqliteNumber(value);
  if (normalized === undefined || !Number.isSafeInteger(normalized) || normalized < minimum) {
    corrupt(`invalid ${field}`, row);
  }
  return normalized;
}

function requiredText(row: SkillRow, value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    corrupt(`invalid ${field}`, row);
  }
  return value;
}

function optionalText(row: SkillRow, value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return requiredText(row, value, field);
}

export function parseSkillSelectionAuditRow(row: SkillRow): SkillSelectionAuditEventRecord {
  const schemaVersion = requiredInteger(row, row.schema_version, "schemaVersion", 1);
  if (schemaVersion !== AUDIT_EVENT_SCHEMA_VERSION) {
    corrupt(`unsupported schemaVersion ${schemaVersion}`, row);
  }
  if (row.action !== "skill.selection.observed") {
    corrupt("invalid action", row);
  }
  if (row.status !== "observed") {
    corrupt("invalid status", row);
  }
  const actorType = requiredText(row, row.actor_type, "actorType");
  if (actorType !== "agent" && actorType !== "system") {
    corrupt("invalid actorType", row);
  }
  return {
    schemaVersion,
    sequence: requiredInteger(row, row.sequence, "sequence", 1),
    eventId: requiredText(row, row.event_id, "eventId"),
    sourceSequence: requiredInteger(row, row.source_sequence, "sourceSequence", 1),
    occurredAt: requiredInteger(row, row.occurred_at, "occurredAt", 0),
    redaction: "metadata_only",
    kind: "skill_selection",
    actorType,
    actorId: requiredText(row, row.actor_id, "actorId"),
    agentId: requiredText(row, row.agent_id, "agentId"),
    ...(optionalText(row, row.session_key, "sessionKey") !== undefined
      ? { sessionKey: requiredText(row, row.session_key, "sessionKey") }
      : {}),
    ...(optionalText(row, row.session_id, "sessionId") !== undefined
      ? { sessionId: requiredText(row, row.session_id, "sessionId") }
      : {}),
    runId: requiredText(row, row.run_id, "runId"),
    toolName: requiredText(row, row.tool_name, "toolName"),
    action: "skill.selection.observed",
    status: "observed",
  };
}
