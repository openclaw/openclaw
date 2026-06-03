import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import type { OpenClawConfig } from "./config-runtime.js";

type ApprovalKind = "exec" | "plugin";
type ApprovalAuthorizationResult = {
  authorized: boolean;
  reason?: string;
};
const IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION = Symbol(
  "openclaw.implicitSameChatApprovalAuthorization",
);

export function markImplicitSameChatApprovalAuthorization(
  /** Authorization result returned when no explicit approver list exists. */
  result: ApprovalAuthorizationResult,
): ApprovalAuthorizationResult {
  // Keep this non-enumerable to avoid changing auth payload shape.
  // Consumers must pass the same object reference to
  // `isImplicitSameChatApprovalAuthorization`; spread/Object.assign/JSON clones
  // drop this marker.
  Object.defineProperty(result, IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION, {
    value: true,
    enumerable: false,
  });
  return result;
}

export function isImplicitSameChatApprovalAuthorization(
  /** Result object returned from approval authorization; cloned results intentionally lose marker state. */
  result: ApprovalAuthorizationResult | null | undefined,
): boolean {
  return Boolean(
    result &&
    (
      result as ApprovalAuthorizationResult & {
        [IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION]?: true;
      }
    )[IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION],
  );
}

export function createResolvedApproverActionAuthAdapter(params: {
  /** Human channel name used in denial copy. */
  channelLabel: string;
  /** Resolve configured approvers for the channel/account before sender normalization. */
  resolveApprovers: (params: { cfg: OpenClawConfig; accountId?: string | null }) => string[];
  /** Channel-specific sender normalization; defaults to optional string trimming. */
  normalizeSenderId?: (value: string) => string | undefined;
}) {
  const normalizeSenderId = params.normalizeSenderId ?? normalizeOptionalString;

  return {
    authorizeActorAction({
      cfg,
      accountId,
      senderId,
      approvalKind,
    }: {
      /** Canonical OpenClaw config used by the approver resolver. */
      cfg: OpenClawConfig;
      /** Optional account scope for multi-account channel approver lists. */
      accountId?: string | null;
      /** Raw channel actor id for the user taking the approval action. */
      senderId?: string | null;
      action: "approve";
      /** Approval family used only for denial copy. */
      approvalKind: ApprovalKind;
    }) {
      const approvers = params.resolveApprovers({ cfg, accountId });
      if (approvers.length === 0) {
        // Empty approver sets are implicit same-chat fallback, not explicit approver bypass.
        return markImplicitSameChatApprovalAuthorization({ authorized: true });
      }
      const normalizedSenderId = senderId ? normalizeSenderId(senderId) : undefined;
      if (normalizedSenderId && approvers.includes(normalizedSenderId)) {
        return { authorized: true } as const;
      }
      return {
        authorized: false,
        reason: `❌ You are not authorized to approve ${approvalKind} requests on ${params.channelLabel}.`,
      } as const;
    },
  };
}
