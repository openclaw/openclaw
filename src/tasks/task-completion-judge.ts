import {
  buildJudgeVerdict,
  evaluateJudgePacket,
  formatJudgeVerdict,
  type JudgeGateVerdict,
} from "../agents/judge-gate.js";

type JudgeTaskCompletionParams = {
  userRequest: string;
  finalText?: string;
  expectedDeliverable?: string;
  artifactIds?: readonly string[];
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  error?: string;
};

export type TaskCompletionJudgeResult = {
  approved: boolean;
  verdict: JudgeGateVerdict;
  artifactIds: string[];
  blockedReason?: string;
};

const WORKING_ONLY_RE =
  /\b(i'?m|i am|we'?re|we are|still|will|going to|let me|checking|working|started|starting|in progress|look into|follow up)\b/i;
const COMPLETION_RE =
  /\b(done|complete|completed|finished|ready|attached|created|built|delivered|here(?:'s| is))\b/i;
const ARTIFACT_REQUEST_RE =
  /\b(video|game|rom|file|download|attachment|image|picture|photo|song|music|audio|pdf|docx|spreadsheet|presentation|app|project|artifact)\b/i;

function trimText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function inferExpectedDeliverable(params: JudgeTaskCompletionParams): string {
  return (
    trimText(params.expectedDeliverable) ||
    (ARTIFACT_REQUEST_RE.test(params.userRequest) ? "requested artifact" : "direct answer")
  );
}

function isWorkingOnlyFinal(text: string): boolean {
  return WORKING_ONLY_RE.test(text) && !COMPLETION_RE.test(text);
}

export function judgeTaskCompletion(params: JudgeTaskCompletionParams): TaskCompletionJudgeResult {
  const finalText = trimText(params.finalText);
  const expectedDeliverable = inferExpectedDeliverable(params);
  const artifactIds = [...new Set((params.artifactIds ?? []).map(trimText).filter(Boolean))];
  const wantsArtifact =
    ARTIFACT_REQUEST_RE.test(params.userRequest) || ARTIFACT_REQUEST_RE.test(expectedDeliverable);
  const evidence = [
    `runtime status: ${params.status}`,
    params.error ? `error: ${params.error}` : undefined,
    finalText ? `final reply: ${finalText}` : "final reply: missing",
    artifactIds.length ? `artifacts: ${artifactIds.join(", ")}` : "artifacts: none",
  ]
    .filter(Boolean)
    .join("; ");

  let forcedVerdict: JudgeGateVerdict | undefined;
  let instructions =
    "Approve only if the final reply directly satisfies the request and required artifacts are present.";
  if (params.status !== "succeeded") {
    forcedVerdict = buildJudgeVerdict({
      verdict: "REJECT",
      scope: expectedDeliverable,
      evidence,
      risk: "low",
      reason: "The runtime did not finish successfully.",
      conditions: "resolve the failed runtime status",
      gate: "task_completion",
    });
    instructions = "Reject because the runtime did not finish successfully.";
  } else if (!finalText) {
    forcedVerdict = buildJudgeVerdict({
      verdict: "REQUEST_MORE_EVIDENCE",
      scope: expectedDeliverable,
      evidence,
      risk: "low",
      reason: "There is no final user-visible reply.",
      conditions: "provide a final answer or explicit blocker",
      gate: "task_completion",
    });
    instructions = "Reject because there is no final user-visible reply.";
  } else if (isWorkingOnlyFinal(finalText)) {
    forcedVerdict = buildJudgeVerdict({
      verdict: "REQUEST_MORE_EVIDENCE",
      scope: expectedDeliverable,
      evidence,
      risk: "low",
      reason: "The final reply only promises future work.",
      conditions: "finish the work or record a concrete blocker",
      gate: "task_completion",
    });
    instructions = "Reject because the final reply only promises future work.";
  } else if (wantsArtifact && artifactIds.length === 0) {
    forcedVerdict = buildJudgeVerdict({
      verdict: "REQUEST_MORE_EVIDENCE",
      scope: expectedDeliverable,
      evidence,
      risk: "low",
      reason: "The request expected an artifact but no artifact was recorded.",
      conditions: "attach or link the requested artifact",
      gate: "task_completion",
    });
    instructions = "Reject because the request expected an artifact but no artifact was recorded.";
  }

  const verdict =
    forcedVerdict ??
    evaluateJudgePacket({
      claim_or_action: `Todd completed user request: ${params.userRequest}`,
      scope: expectedDeliverable,
      evidence,
      instructions,
      risk: "low",
      requested_verdict: "APPROVE",
      gate: "task_completion",
    });
  const approved = verdict.verdict === "APPROVE";
  return {
    approved,
    verdict,
    artifactIds,
    ...(approved ? {} : { blockedReason: formatJudgeVerdict(verdict) }),
  };
}
