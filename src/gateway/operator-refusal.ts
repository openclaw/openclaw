import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { readMissingScopeError } from "../../packages/gateway-protocol/src/missing-scope-error.js";

/**
 * The one owner of refusal text for operator work. A refusal says what was not done, whose
 * access stopped it and why, and the one next step that can help that person.
 */
const refusalCauses = {
  "access-ended": {
    why: "Your access to this Gateway has ended.",
    nextStep: "Ask a Gateway admin to restore it.",
  },
  "sign-in-ended": {
    why: "The sign-in it was started with is no longer valid.",
    nextStep: "Reconnect to the Gateway, then send your message again.",
  },
  "role-denies": {
    why: "Your role on this Gateway does not allow it.",
    nextStep: "Ask a Gateway admin to do it, or to add the permission to your role.",
  },
  "owner-only": {
    why: "It needs the Gateway owner's authority, and this turn does not run with it.",
    nextStep: "Ask the Gateway owner to do it.",
  },
  "channel-unverified": {
    why: "This channel cannot confirm who you are.",
    nextStep:
      "Use Control UI, Discord or Telegram for this. If you are not the Gateway owner, ask an admin to link your channel account to your Gateway profile first.",
  },
  "agent-not-in-role": {
    why: "Your role on this Gateway does not include this agent.",
    nextStep: "Choose an allowed agent, or ask a Gateway admin to add it to your role.",
  },
  "tool-policy-denies": {
    why: "This session's current tool policy does not allow it.",
    nextStep: "Ask a Gateway admin to change the session's tool policy, or use another session.",
  },
  "channel-access-ended": {
    why: "The sender no longer has access to this channel.",
    nextStep: "Review the channel access settings, then ask the sender to send it again.",
  },
  "owner-removed": {
    why: "Your channel account is no longer listed as a Gateway owner.",
    nextStep:
      "Ask the Gateway owner to add it back to commands.ownerAllowFrom, then send a new message.",
  },
  "requester-access-ended": {
    why: "The access of the person who started it has ended.",
    nextStep: "Ask them or a Gateway admin to restore that access, then start the task again.",
  },
  "invitation-ended": {
    why: "The invitation you joined this session with has ended.",
    nextStep: "Ask the session owner to invite you again.",
  },
  "github-not-linked": {
    why: "Your Gateway profile has no linked GitHub account, so I cannot check that the PR is yours.",
    nextStep:
      "Link it once in the Control UI under Settings → Profile → Identity, on the configured GitHub host, then ask again.",
  },
  "automation-account-unrecorded": {
    why: "It has no recorded inference account, so OpenClaw refused the selected credentials.",
    nextStep:
      "Select an authorized stored account with `openclaw automations edit <jobId> --model <provider/model>@<account>`, or use a configured provider key. For eligible host-managed accounts, `openclaw doctor --fix` can record the account.",
  },
  "workspace-not-owned": {
    why: "Only the person who started this conversation or an administrator can restore its workspace.",
    nextStep: "Ask an administrator to restore this workspace, or start a new conversation.",
  },
} as const satisfies Record<string, { why: string; nextStep: string }>;

export type OperatorRefusalCause = keyof typeof refusalCauses;

/** The person-facing sentence for one refusal. `action` names the refused work in their words. */
export function operatorRefusalText(cause: OperatorRefusalCause, action = "start this request") {
  const { why, nextStep } = refusalCauses[cause];
  return `I did not ${action}. ${why} ${nextStep}`;
}

/** A definite refusal of operator work. Its message is the sentence the person sees. */
export class OperatorRefusalError extends Error {
  constructor(
    readonly refusal: OperatorRefusalCause,
    options?: ErrorOptions & { action?: string },
  ) {
    super(operatorRefusalText(refusal, options?.action), options);
    this.name = "OperatorRefusalError";
  }
}

/** The model gets the person's sentence and is told not to retry, so it invents no other reason. */
export function readOperatorRefusalToolText(error: unknown, toolName: string): string | undefined {
  const refusal = collectNestedErrorCandidates(error).find(
    (candidate) => candidate instanceof OperatorRefusalError,
  );
  if (refusal) {
    return `${refusal.message} Do not retry.`;
  }
  return readMissingScopeError(error)
    ? `${operatorRefusalText("role-denies", `run this ${toolName} action`)} Do not retry.`
    : undefined;
}
