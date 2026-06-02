import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import type { OpenClawConfig } from "./config-runtime.js";

type ApprovalKind = "exec" | "plugin";
type ApprovalAuthorizationResult = {
  /** True when the sender may resolve the approval action. */
  authorized: boolean;
  /** User-facing denial reason returned to the channel, when authorization fails. */
  reason?: string;
};
const IMPLICIT_SAME_CHAT_APPROVAL_AUTHORIZATION = Symbol(
  "openclaw.implicitSameChatApprovalAuthorization",
);

/** Marks an allow result as the implicit same-chat fallback rather than explicit approver auth. */
export function markImplicitSameChatApprovalAuthorization(
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

/** Checks whether an authorization result came from implicit same-chat fallback auth. */
export function isImplicitSameChatApprovalAuthorization(
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
  /** Human-readable channel label used in denial replies. */
  channelLabel: string;
  /** Returns normalized approver ids for the evaluated config/account. */
  resolveApprovers: (params: { cfg: OpenClawConfig; accountId?: string | null }) => string[];
  /** Optional sender normalization hook for channel-specific id grammar. */
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
      cfg: OpenClawConfig;
      accountId?: string | null;
      senderId?: string | null;
      action: "approve";
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
