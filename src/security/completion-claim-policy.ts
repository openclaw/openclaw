import type { ActionSinkEvidenceArtifact } from "./action-sink-evidence.js";
import { verifyActionSinkEvidence } from "./action-sink-evidence.js";
import type { PolicyModule, PolicyRequest } from "./action-sink-policy.js";
import { policyResult } from "./action-sink-policy.js";

const CLAIM_RE = /\b(done|ready|built|landed|complete|completed|shipped|fixed|implemented|live)\b/i;

export function containsCompletionClaim(text: string): boolean {
  return CLAIM_RE.test(text);
}

export function createEvidenceGatePolicyModule(expected: {
  repoRoot: string;
  branch: string;
  commitSha?: string;
  commitRange?: string;
}): PolicyModule {
  return {
    id: "evidenceGate",
    evaluate(request: PolicyRequest) {
      const text =
        (typeof request.payloadSummary === "string" ? request.payloadSummary : undefined) ??
        (typeof request.context?.text === "string" ? request.context.text : "");
      const isClaim =
        request.actionType === "completion_claim" ||
        (request.actionType === "message_send" && containsCompletionClaim(text));
      const isTransition =
        request.actionType === "status_transition" &&
        /done|ready|complete|succeeded/.test(
          typeof request.context?.status === "string" ? request.context.status : "",
        );
      if (!isClaim && !isTransition) {
        return undefined;
      }
      const evidence = request.context?.evidence as ActionSinkEvidenceArtifact | undefined;
      if (!evidence) {
        return policyResult({
          policyId: "evidenceGate",
          decision: "block",
          reasonCode: "missing_evidence",
          reason: "Completion/status claim requires review and QA evidence",
          correlationId: request.correlationId,
        });
      }
      const verified = verifyActionSinkEvidence(evidence, expected);
      if (!verified.ok) {
        return policyResult({
          policyId: "evidenceGate",
          decision: "block",
          reasonCode: verified.reason.includes("stale") ? "stale_evidence" : "missing_evidence",
          reason: `Evidence rejected: ${verified.reason}`,
          correlationId: request.correlationId,
        });
      }
      return undefined;
    },
  };
}
