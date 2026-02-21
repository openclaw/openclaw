import { recordChannelActivity } from "../infra/channel-activity.js";
import { watiApiRequest, type WatiApiOpts } from "./api.js";
import type { WatiSendResult, WatiTemplateParams } from "./types.js";

export type WatiSendOpts = WatiApiOpts & {
  accountId?: string;
};

/**
 * Send a text message via WATI v3 API.
 */
export async function sendMessageWati(
  to: string,
  text: string,
  opts: WatiSendOpts,
): Promise<WatiSendResult> {
  const res = await watiApiRequest(
    "/api/ext/v3/conversations/messages/text",
    {
      method: "POST",
      body: JSON.stringify({ target: to, text }),
    },
    opts,
  );

  recordChannelActivity({
    channel: "wati",
    accountId: opts.accountId,
    direction: "outbound",
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, string>;
  return {
    messageId: String(json.id ?? json.messageId ?? ""),
    chatId: String(json.chatId ?? to),
  };
}

/**
 * Send a template message via WATI v3 API.
 */
export async function sendTemplateMessageWati(
  to: string,
  template: WatiTemplateParams,
  opts: WatiSendOpts,
): Promise<WatiSendResult> {
  const res = await watiApiRequest(
    "/api/ext/v3/conversations/messages/template",
    {
      method: "POST",
      body: JSON.stringify({
        target: to,
        template_name: template.templateName,
        parameters: template.parameters,
      }),
    },
    opts,
  );

  recordChannelActivity({
    channel: "wati",
    accountId: opts.accountId,
    direction: "outbound",
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, string>;
  return {
    messageId: String(json.id ?? json.messageId ?? ""),
    chatId: String(json.chatId ?? to),
  };
}
