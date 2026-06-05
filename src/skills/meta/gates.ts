import { randomUUID } from "node:crypto";
import type { JsonRecord, MetaRunStore } from "./store.js";

export type MetaGateResult = {
  name: string;
  result: "passed" | "failed" | "skipped";
  riskLevel?: string;
  evidenceJson?: JsonRecord;
  artifactRefsJson?: JsonRecord;
  summary?: string;
};

export type RecordMetaGateEvidenceOptions = {
  store: Pick<MetaRunStore, "recordEvidence">;
  runId: string;
  results: MetaGateResult[];
  stepId?: string;
  proposalId?: string;
  createdAtMs: number;
  createId?: () => string;
};

export type MetaGateEvidence = {
  results: MetaGateResult[];
  proposalId?: string;
};

export function summarizeMetaGateResults(results: MetaGateResult[]): {
  result: "passed" | "failed";
  evidence: string;
} {
  const failed = results.some((entry) => entry.result === "failed");
  return {
    result: failed ? "failed" : "passed",
    evidence: results
      .map((entry) => {
        const suffix = entry.summary ? ` - ${entry.summary}` : "";
        return `${entry.name}: ${entry.result}${suffix}`;
      })
      .join("\n"),
  };
}

export function recordMetaGateEvidence(options: RecordMetaGateEvidenceOptions): void {
  const createId = options.createId ?? randomUUID;
  for (const result of options.results) {
    options.store.recordEvidence({
      evidenceId: `gate-${createId()}`,
      runId: options.runId,
      ...(options.stepId ? { stepId: options.stepId } : {}),
      ...(options.proposalId ? { proposalId: options.proposalId } : {}),
      gateName: result.name,
      result: result.result,
      ...(result.riskLevel ? { riskLevel: result.riskLevel } : {}),
      evidenceJson: {
        result: result.result,
        ...(result.summary ? { summary: result.summary } : {}),
        ...result.evidenceJson,
      },
      ...(result.artifactRefsJson ? { artifactRefsJson: result.artifactRefsJson } : {}),
      createdAtMs: options.createdAtMs,
    });
  }
}
