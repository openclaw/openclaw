import type { LaneExecutionResult } from "./lane-executors.js";
import type { TriageLane, TriageLaneScore, TriagePolicyDecision } from "./triage-router.js";

export type TriageAuditInfo = {
  policyVersion: string;
  triageVersion: string;
  traceId: string;
};

export type ComposeTriageResponseInput = {
  ok: boolean;
  requestId: string;
  decision: TriagePolicyDecision;
  lane: TriageLane;
  laneScores: TriageLaneScore[];
  result: LaneExecutionResult;
  riskScore: number;
  latencyMs: number;
  audit: TriageAuditInfo;
};

export function composeTriageResponse(input: ComposeTriageResponseInput) {
  const confidence = input.laneScores.find((item) => item.lane === input.lane)?.score ?? 0;
  return {
    ok: input.ok,
    requestId: input.requestId,
    decision: input.decision,
    lane: input.lane,
    status: input.result.status,
    answer: {
      text: input.result.answerText,
      channelSafeText: input.result.answerText,
    },
    meta: {
      confidence,
      riskScore: input.riskScore,
      latencyMs: input.latencyMs,
      escalated: input.result.escalation.required,
    },
    evidence: input.result.evidence,
    usage: input.result.usage,
    escalation: input.result.escalation,
    audit: {
      policyVersion: input.audit.policyVersion,
      triageVersion: input.audit.triageVersion,
      traceId: input.audit.traceId,
    },
  };
}