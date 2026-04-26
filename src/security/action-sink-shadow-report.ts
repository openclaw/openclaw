import type { ActionSinkAuditRecord } from "./action-sink-audit.js";

export type ShadowReport = {
  total: number;
  wouldBlock: number;
  wouldRequireApproval: number;
  byReason: Record<string, number>;
};

export function buildActionSinkShadowReport(records: ActionSinkAuditRecord[]): ShadowReport {
  const report: ShadowReport = {
    total: records.length,
    wouldBlock: 0,
    wouldRequireApproval: 0,
    byReason: {},
  };
  for (const record of records) {
    report.byReason[record.reasonCode] = (report.byReason[record.reasonCode] ?? 0) + 1;
    if (record.mode === "shadow" && /would have block/i.test(record.reason)) report.wouldBlock += 1;
    if (record.mode === "shadow" && /would have requireApproval/i.test(record.reason))
      report.wouldRequireApproval += 1;
  }
  return report;
}
