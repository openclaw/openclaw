import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { OpenClawConfig } from "./config-runtime.js";

type ApprovalKind = "exec" | "plugin";

export function createResolvedApproverActionAuthAdapter(params: {
  channelLabel: string;
  resolveApprovers: (params: { cfg: OpenClawConfig; accountId?: string | null }) => string[];
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
        return { authorized: true } as const;
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
