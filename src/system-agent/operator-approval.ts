// Host-owned authorization for exact delegated OpenClaw changes.
import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { SystemAgentOperation } from "./operation-types.js";
import { isPersistentSystemAgentOperation } from "./operations-parse.js";

export type SystemAgentProposalRef = { current?: string; operation?: SystemAgentOperation };

const APPROVAL_RETRY_GUIDANCE =
  "If the change is still needed, submit a fresh request and approve it in the Control UI or OpenClaw apps, or through the approval prompt in the requesting chat. Retrying alone does not approve the change.";

export const SYSTEM_AGENT_APPROVAL_APPLICATION_UNCONFIRMED_TEXT =
  "The approved change's application status is unconfirmed. Check the current settings and OpenClaw status before retrying.";

export const SYSTEM_AGENT_APPROVAL_TERMINAL_MESSAGES = {
  expired: `OpenClaw approval request expired without a decision. No change was made. The expired request can no longer be approved. ${APPROVAL_RETRY_GUIDANCE}`,
  cancelled: `OpenClaw change cancelled before application. No change was made. The approval request is no longer active. ${APPROVAL_RETRY_GUIDANCE}`,
  failed: `OpenClaw change failed to complete. ${SYSTEM_AGENT_APPROVAL_APPLICATION_UNCONFIRMED_TEXT}`,
};

/** Canonical operation fingerprint used to bind approval to one exact mutation. */
export function hashSystemAgentOperation(operation: SystemAgentOperation): string {
  return sha256Hex(stableStringify(operation));
}

export type SystemAgentApprovalIntent = "approve" | "decline" | "other";

const APPROVE_RE =
  /^(?:y|yes|yeah|yep|yup|sure|ok|okay|approve|approved|apply|confirm|confirmed|do it|go ahead|sounds good|yes please|please do)$/i;
const DECLINE_RE = /^(?:n|no|nope|nah|skip|not now|cancel|stop|abort|later|decline|don'?t)\b/i;

/** Deterministic whole-message approvals and prefix declines. */
export function classifySystemAgentApprovalText(message: string): SystemAgentApprovalIntent {
  const normalized = message
    .trim()
    .replace(/[.!?,\s]+$/u, "")
    .toLowerCase();
  if (!normalized) {
    return "other";
  }
  if (APPROVE_RE.test(normalized)) {
    return "approve";
  }
  if (DECLINE_RE.test(normalized)) {
    return "decline";
  }
  return "other";
}

export function resolvePendingOperatorProposal(
  pending: SystemAgentOperation | null,
  proposalRef: SystemAgentProposalRef,
): { operation: SystemAgentOperation; hash: string } | null {
  const operation = pending ?? proposalRef.operation;
  if (!operation || !isPersistentSystemAgentOperation(operation)) {
    return null;
  }
  const hash = hashSystemAgentOperation(operation);
  if (proposalRef.current && proposalRef.current !== hash) {
    return null;
  }
  return { operation, hash };
}

export async function resolveOperatorApprovalDecision<T>(params: {
  decision: "allow-once" | "allow-always" | "deny" | null;
  proposalHash: string;
  getProposal: () => { operation: SystemAgentOperation; hash: string } | null;
  clear: () => void;
  apply: (operation: SystemAgentOperation) => Promise<T>;
  denied: () => T;
}): Promise<T | null> {
  const proposal = params.getProposal();
  if (!proposal || proposal.hash !== params.proposalHash) {
    return null;
  }
  if (params.decision !== "allow-once") {
    params.clear();
    return params.denied();
  }
  // Consume authority before applying so duplicate callbacks and failures
  // cannot replay an already-approved operation.
  params.clear();
  return await params.apply(proposal.operation);
}
