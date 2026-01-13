import { jsonResult, readStringParam } from "../../../agents/tools/common.js";
import type { ClawdbotConfig } from "../../../config/config.js";
import {
  listZaloAccountIds,
  resolveZaloAccount,
} from "../../../zalo/accounts.js";
import { sendMessageZalo } from "../../../zalo/send.js";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "../types.js";

const providerId = "zalo";

function listEnabledZaloAccounts(cfg: ClawdbotConfig) {
  return listZaloAccountIds(cfg)
    .map((accountId) => resolveZaloAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.tokenSource !== "none");
}

export const zaloMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledZaloAccounts(cfg);
    if (accounts.length === 0) return [];
    // Zalo only supports sending messages (no reactions)
    const actions = new Set<ChannelMessageActionName>(["send"]);
    return Array.from(actions);
  },
  supportsButtons: () => false, // Zalo doesn't support inline buttons
  extractToolSend: ({ args }) => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== "sendMessage") return null;
    const to = typeof args.to === "string" ? args.to : undefined;
    const content = typeof args.content === "string" ? args.content : "";
    const mediaUrl = readStringParam(args, "mediaUrl") ?? undefined;
    if (!to || !content) return null;
    return {
      providerId,
      to,
      content,
      mediaUrl,
    };
  },
  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const content = readStringParam(params, "message", {
        required: true,
        allowEmpty: true,
      });
      const mediaUrl = readStringParam(params, "media", { trim: false });

      const result = await sendMessageZalo(to, content ?? "", {
        accountId: accountId ?? undefined,
        mediaUrl: mediaUrl ?? undefined,
        cfg,
      });

      if (!result.ok) {
        return jsonResult({
          ok: false,
          error: result.error ?? "Failed to send Zalo message",
        });
      }

      return jsonResult({
        ok: true,
        to,
        messageId: result.messageId,
      });
    }

    throw new Error(
      `Action ${action} is not supported for provider ${providerId}.`,
    );
  },
};
