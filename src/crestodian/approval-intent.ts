// Classifies whether a user's chat message approves a pending Crestodian proposal.
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { extractAssistantText } from "../agents/embedded-agent-utils.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "../agents/simple-completion-runtime.js";
import { readConfigFileSnapshot } from "../config/config.js";

/**
 * Approval detection for pending mutations. The host — not the conversation
 * model — decides whether a turn is armed, so the agent loop can never
 * self-approve (see crestodian-tool.ts). Users approve in their own words:
 * unambiguous replies resolve instantly from a closed list, everything else is
 * judged by a separate single-shot model call that sees only the user's
 * message and the proposal description, never tool output. When no completion
 * model is usable the closed list is the whole decision — "other" (the safe
 * default) keeps the proposal pending and the conversation re-asks.
 */
export type CrestodianApprovalIntent = "approve" | "decline" | "other";

export type CrestodianApprovalClassifier = (params: {
  message: string;
  /** Human-readable proposal description when the host knows it. */
  proposal?: string;
}) => Promise<CrestodianApprovalIntent>;

const APPROVAL_INTENT_TIMEOUT_MS = 10_000;
const APPROVAL_INTENT_MAX_TOKENS = 8;

// Approvals arm a mutation, so the deterministic list is whole-message only;
// declines merely drop a proposal, so a leading match ("no thanks") suffices.
const APPROVE_RE =
  /^(?:y|yes|yeah|yep|yup|sure|ok|okay|approve|approved|apply|confirm|confirmed|do it|go ahead|sounds good|yes please|please do)$/i;
const DECLINE_RE = /^(?:n|no|nope|nah|skip|not now|cancel|stop|abort|later|decline|don'?t)\b/i;

function normalizeApprovalText(message: string): string {
  return message
    .trim()
    .replace(/[.!?,\s]+$/u, "")
    .toLowerCase();
}

/** Closed-list classification: exact affirmatives, prefix declines. */
export function classifyCrestodianApprovalText(message: string): CrestodianApprovalIntent {
  const normalized = normalizeApprovalText(message);
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

const APPROVAL_INTENT_SYSTEM_PROMPT = [
  "You classify one chat message from a user who was just asked to approve a pending configuration change.",
  "Reply with exactly one word:",
  "approve — the message clearly consents to applying the pending change now.",
  "decline — the message clearly rejects or postpones the pending change.",
  "other — anything else: questions, new requests, partial or conditional agreement, or unclear intent.",
  "Only classify consent for the pending change itself. A message asking to change the proposal is not approval.",
].join("\n");

export type CrestodianApprovalIntentDeps = {
  readConfigFileSnapshot?: typeof readConfigFileSnapshot;
  prepareSimpleCompletionModelForAgent?: typeof prepareSimpleCompletionModelForAgent;
  completeWithPreparedSimpleCompletionModel?: typeof completeWithPreparedSimpleCompletionModel;
};

/**
 * Judge whether a message approves the pending proposal. Deterministic
 * closed-list answers short-circuit (a literal "yes" needs no model and must
 * keep working on configless machines); ambiguous messages go to the
 * configured completion model. CLI-harness-only hosts get no model judgment —
 * spawning a full harness per approval check is too slow — so their ambiguous
 * replies stay "other" and the conversation asks for a clear yes.
 */
export async function classifyCrestodianApprovalIntent(
  params: {
    message: string;
    proposal?: string;
  },
  deps: CrestodianApprovalIntentDeps = {},
): Promise<CrestodianApprovalIntent> {
  const textIntent = classifyCrestodianApprovalText(params.message);
  if (textIntent !== "other") {
    return textIntent;
  }
  try {
    const snapshot = await (deps.readConfigFileSnapshot ?? readConfigFileSnapshot)();
    if (!snapshot.exists || !snapshot.valid) {
      return "other";
    }
    const cfg = snapshot.runtimeConfig ?? snapshot.config;
    const prepared = await (
      deps.prepareSimpleCompletionModelForAgent ?? prepareSimpleCompletionModelForAgent
    )({
      cfg,
      agentId: resolveDefaultAgentId(cfg),
      allowMissingApiKeyModes: ["aws-sdk"],
    });
    if ("error" in prepared) {
      return "other";
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), APPROVAL_INTENT_TIMEOUT_MS);
    try {
      const response = await (
        deps.completeWithPreparedSimpleCompletionModel ?? completeWithPreparedSimpleCompletionModel
      )({
        model: prepared.model,
        auth: prepared.auth,
        context: {
          systemPrompt: APPROVAL_INTENT_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                `Pending change: ${params.proposal ?? "a configuration change proposed in this conversation"}`,
                `User message: ${params.message}`,
              ].join("\n"),
              timestamp: Date.now(),
            },
          ],
        },
        options: {
          maxTokens: APPROVAL_INTENT_MAX_TOKENS,
          signal: controller.signal,
        },
      });
      const verdict = extractAssistantText(response)?.trim().toLowerCase().split(/\s+/)[0];
      if (verdict === "approve" || verdict === "decline") {
        return verdict;
      }
      return "other";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Approval must fail closed: an unreachable model means no arming.
    return "other";
  }
}
