// ACP tool-call message edits: update a routed tool message in place, withheld once revoked.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { ReplyPayload } from "../types.js";
import type { AcpRoutedSendGuard } from "./dispatch-acp-delivery-binding.js";
import type {
  AcpDispatchDeliveryParams,
  AcpDispatchDeliveryState,
} from "./dispatch-acp-delivery.types.js";

const messageActionRuntimeLoader = createLazyImportLoader(
  () => import("../../infra/outbound/message-action-runner.js"),
);

export function createAcpToolMessageEditor(
  params: AcpDispatchDeliveryParams,
  state: AcpDispatchDeliveryState,
  routedSendGuard: (() => Promise<AcpRoutedSendGuard>) | undefined,
) {
  return async (payload: ReplyPayload, toolCallId: string): Promise<boolean> => {
    const handle = state.toolMessageByCallId.get(toolCallId);
    if (!handle?.messageId) {
      return false;
    }
    const message = normalizeOptionalString(payload.text);
    if (!message) {
      return false;
    }

    try {
      const { runMessageAction } = await messageActionRuntimeLoader.load();
      if (await params.isUserDeliveryRevoked?.()) {
        return true; // Withheld: a revoked binding must not edit or re-send.
      }
      const guard = await routedSendGuard?.();
      await runMessageAction({
        ...(guard ? { onPlatformSendDispatch: guard.beforeDeliver } : {}),
        cfg: params.cfg,
        action: "edit",
        params: {
          channel: handle.channel,
          to: handle.to,
          threadId: handle.threadId,
          messageId: handle.messageId,
          message,
        },
        defaultAccountId: handle.accountId,
        sessionKey: params.ctx.SessionKey,
        requesterAccountId: params.ctx.AccountId,
      });
      state.routedCounts.tool += 1;
      return true;
    } catch (error) {
      logVerbose(
        `dispatch-acp: tool message edit failed for ${toolCallId}: ${formatErrorMessage(error)}`,
      );
      return false;
    }
  };
}
