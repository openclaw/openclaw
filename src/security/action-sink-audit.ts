import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  PolicyActionType,
  PolicyDecision,
  PolicyMode,
  PolicyRequest,
  PolicyResult,
} from "./action-sink-policy.js";
import { summarizePolicyPayload } from "./action-sink-policy.js";

export type ActionSinkAuditRecord = {
  timestamp: string;
  policyVersion: string;
  actor?: PolicyRequest["actor"];
  policyId: string;
  decision: PolicyDecision;
  actionType: PolicyActionType;
  targetSummary?: unknown;
  payloadSummary?: unknown;
  reasonCode: string;
  reason: string;
  mode: PolicyMode;
  correlationId: string;
};

export function createActionSinkAuditRecord(params: {
  request: PolicyRequest;
  result: PolicyResult;
  now?: Date;
}): ActionSinkAuditRecord {
  return {
    timestamp: (params.now ?? new Date()).toISOString(),
    policyVersion: params.request.policyVersion,
    actor: params.request.actor,
    policyId: params.result.policyId,
    decision: params.result.decision,
    actionType: params.request.actionType,
    targetSummary: summarizePolicyPayload(params.request.targetResource),
    payloadSummary: summarizePolicyPayload(params.request.payloadSummary),
    reasonCode: params.result.reasonCode,
    reason: params.result.reason,
    mode: params.result.mode ?? "enforce",
    correlationId: params.result.correlationId ?? params.request.correlationId ?? randomUUID(),
  };
}

export function validateActionSinkAuditRecord(
  record: Partial<ActionSinkAuditRecord>,
): asserts record is ActionSinkAuditRecord {
  for (const field of [
    "timestamp",
    "policyVersion",
    "policyId",
    "decision",
    "actionType",
    "reasonCode",
    "reason",
    "mode",
    "correlationId",
  ] as const) {
    if (typeof record[field] !== "string" || !record[field]) {
      throw new Error(`audit record missing ${field}`);
    }
  }
}

export async function appendActionSinkAuditRecord(
  filePath: string,
  record: ActionSinkAuditRecord,
): Promise<void> {
  validateActionSinkAuditRecord(record);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
}

export async function auditPolicyDecision(params: {
  auditPath: string;
  request: PolicyRequest;
  result: PolicyResult;
  highRisk?: boolean;
}): Promise<ActionSinkAuditRecord> {
  const record = createActionSinkAuditRecord(params);
  try {
    await appendActionSinkAuditRecord(params.auditPath, record);
    return record;
  } catch (err) {
    if (params.highRisk) {
      throw new Error(
        `Action sink audit append failed closed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.warn(`Action sink audit append failed open: ${String(err)}`);
    return record;
  }
}

export async function readActionSinkAuditRecords(
  filePath: string,
): Promise<ActionSinkAuditRecord[]> {
  const text = await fs.readFile(filePath, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw err;
  });
  return text.trim()
    ? text
        .trim()
        .split(/\n+/)
        .map((line) => JSON.parse(line) as ActionSinkAuditRecord)
    : [];
}
