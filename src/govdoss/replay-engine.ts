import { govdossAuditStore, type GovdossAuditRecord } from "./audit-store.js";

export type GovdossReplayFrame = {
  at: number;
  action: string;
  subject: string;
  object?: string;
  result: string;
  metadata?: Record<string, unknown>;
};

export type GovdossForensicsReport = {
  tenantId?: string;
  totalEvents: number;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  actions: Record<string, number>;
  results: Record<string, number>;
  subjects: Record<string, number>;
  timeline: GovdossReplayFrame[];
};

function summarize(records: GovdossAuditRecord[]) {
  const actions: Record<string, number> = {};
  const results: Record<string, number> = {};
  const subjects: Record<string, number> = {};
  for (const record of records) {
    actions[record.action] = (actions[record.action] ?? 0) + 1;
    results[record.result] = (results[record.result] ?? 0) + 1;
    subjects[record.subject] = (subjects[record.subject] ?? 0) + 1;
  }
  return { actions, results, subjects };
}

export function buildGovdossReplayTimeline(input: {
  tenantId?: string;
  limit?: number;
}): GovdossReplayFrame[] {
  const records = govdossAuditStore.listByTenant(input.tenantId, input.limit ?? 200).slice().reverse();
  return records.map((record) => ({
    at: record.timestamp,
    action: record.action,
    subject: record.subject,
    object: record.object,
    result: record.result,
    metadata: record.metadata,
  }));
}

export function buildGovdossForensicsReport(input: {
  tenantId?: string;
  limit?: number;
}): GovdossForensicsReport {
  const records = govdossAuditStore.listByTenant(input.tenantId, input.limit ?? 200).slice().reverse();
  const { actions, results, subjects } = summarize(records);
  return {
    tenantId: input.tenantId,
    totalEvents: records.length,
    firstSeenAt: records.length ? records[0].timestamp : null,
    lastSeenAt: records.length ? records[records.length - 1].timestamp : null,
    actions,
    results,
    subjects,
    timeline: records.map((record) => ({
      at: record.timestamp,
      action: record.action,
      subject: record.subject,
      object: record.object,
      result: record.result,
      metadata: record.metadata,
    })),
  };
}
