// Approval auth helpers resolve actor and channel identity for approval requests.
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import { resolveApprovalApprovers } from "./approval-approvers.js";
import type { OpenClawConfig } from "./config-runtime.js";

type ApproverInput = string | number;
type ApprovalApproverInputs = {
  explicit?: readonly ApproverInput[] | null;
  allowFrom?: readonly ApproverInput[] | null;
  extraAllowFrom?: readonly ApproverInput[] | null;
  defaultTo?: string | null;
};
type ApprovalContext = {
  cfg: OpenClawConfig;
  accountId?: string | null;
};
type ApprovalActorContext = ApprovalContext & {
  senderId?: string | null;
};
type ApprovalActorActionContext = ApprovalActorContext & {
  action: "approve";
  approvalKind: ChannelApprovalKind;
};
type ChannelApprovalAuth = {
  resolveApprovers: (context: ApprovalContext) => string[];
  isAuthorizedSender: (context: ApprovalActorContext) => boolean;
  approvalAuth: ReturnType<typeof createResolvedApproverActionAuthAdapter>;
};
type ApprovalAuthorizationResult = {
  /** Whether the actor may perform the approval action. */
  authorized: boolean;
  /** User-facing denial reason when authorization fails. */
  reason?: string;
};
const IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION = Symbol(
  "openclaw.implicitSameChatApprovalAuthorization",
);

/** Empty approver lists permit same-chat replies without bypassing sender admission. */
export function markImplicitSameChatApprovalAuthorization(
  result: ApprovalAuthorizationResult,
): ApprovalAuthorizationResult {
  Object.defineProperty(result, IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION, {
    value: true,
    enumerable: false,
  });
  return result;
}

export function isImplicitSameChatApprovalAuthorization(
  result: ApprovalAuthorizationResult | null | undefined,
): boolean {
  return Boolean(result && Reflect.get(result, IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION));
}

function authorizeApproverAction(
  approvers: readonly string[],
  allowed: boolean,
  channelLabel: string,
  kind: ChannelApprovalKind,
): ApprovalAuthorizationResult {
  if (allowed) {
    return { authorized: true };
  }
  return approvers.length === 0
    ? markImplicitSameChatApprovalAuthorization({ authorized: true })
    : {
        authorized: false,
        reason: `❌ You are not authorized to approve ${kind} requests on ${channelLabel}.`,
      };
}

export function createResolvedApproverActionAuthAdapter(params: {
  channelLabel: string;
  resolveApprovers: (params: { cfg: OpenClawConfig; accountId?: string | null }) => string[];
  normalizeSenderId?: (value: string) => string | undefined;
}) {
  const normalizeSenderId = params.normalizeSenderId ?? normalizeOptionalString;

  return {
    authorizeActorAction({ cfg, accountId, senderId, approvalKind }: ApprovalActorActionContext) {
      const approvers = params.resolveApprovers({ cfg, accountId });
      const normalizedSenderId =
        approvers.length && senderId ? normalizeSenderId(senderId) : undefined;
      return authorizeApproverAction(
        approvers,
        Boolean(normalizedSenderId && approvers.includes(normalizedSenderId)),
        params.channelLabel,
        approvalKind,
      );
    },
  };
}

// Builds account-scoped approver resolution, sender checks, and action auth.
export function createChannelApprovalAuth(params: {
  channelLabel: string;
  resolveInputs: (params: ApprovalContext) => ApprovalApproverInputs;
  normalizeApprover: (value: ApproverInput) => string | undefined;
  normalizeDefaultTo?: (value: string) => string | undefined;
  normalizeSenderId?: (value: string) => string | undefined;
  isWildcardAuthorized?: (params: {
    purpose: "sender" | "action";
    senderId?: string;
    inputs: ApprovalApproverInputs;
    approvers: readonly string[];
  }) => boolean;
}): ChannelApprovalAuth {
  const normalizeSenderId =
    params.normalizeSenderId ?? ((value: string) => params.normalizeApprover(value));
  const resolve = (context: ApprovalActorContext) => {
    const inputs = params.resolveInputs(context);
    const approvers = resolveApprovalApprovers({
      ...inputs,
      normalizeApprover: params.normalizeApprover,
      normalizeDefaultTo: params.normalizeDefaultTo,
    });
    const senderId = context.senderId ? normalizeSenderId(context.senderId) : undefined;
    return { inputs, approvers, senderId };
  };
  const isAllowed = (purpose: "sender" | "action", resolved: ReturnType<typeof resolve>) =>
    params.isWildcardAuthorized?.({ purpose, ...resolved }) === true ||
    Boolean(resolved.senderId && resolved.approvers.includes(resolved.senderId));
  return {
    resolveApprovers: (context) => resolve(context).approvers,
    isAuthorizedSender: (context) => isAllowed("sender", resolve(context)),
    approvalAuth: {
      authorizeActorAction(input: ApprovalActorActionContext) {
        const resolved = resolve(input);
        return authorizeApproverAction(
          resolved.approvers,
          isAllowed("action", resolved),
          params.channelLabel,
          input.approvalKind,
        );
      },
    },
  };
}
