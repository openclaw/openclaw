import type { McpConnectAction } from "../../agents/mcp-connect-action.js";
import type { McpAppChannelView } from "../../agents/mcp-ui-resource.js";
import { materializeMcpAppChannelPresentation } from "../../gateway/mcp-app-channel-action.js";
import { isReplyPayloadTerminalContent } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

function attachChannelPresentation(
  payloads: ReplyPayload[],
  createPresentation: () => ReplyPayload["presentation"],
): ReplyPayload[] {
  const index = payloads.findLastIndex(
    (payload) =>
      Boolean(payload.text?.trim()) &&
      payload.isError !== true &&
      isReplyPayloadTerminalContent(payload),
  );
  if (index < 0) {
    return payloads;
  }
  // Mint portable actions only after finding a visible terminal reply.
  const presentation = createPresentation();
  if (!presentation) {
    return payloads;
  }
  const result = payloads.slice();
  const payload = payloads[index]!;
  result[index] = {
    ...payload,
    presentation: payload.presentation
      ? {
          ...payload.presentation,
          blocks: [...payload.presentation.blocks, ...presentation.blocks],
        }
      : presentation,
  };
  return result;
}

export function attachMcpAppChannelAction(params: {
  payloads: ReplyPayload[];
  channel?: string;
  sessionKey?: string;
  view?: McpAppChannelView;
}): ReplyPayload[] {
  const { channel, sessionKey, view } = params;
  if (!channel || channel === "webchat" || !sessionKey || !view) {
    return params.payloads;
  }
  return attachChannelPresentation(params.payloads, () =>
    materializeMcpAppChannelPresentation({ sessionKey, view }),
  );
}

export function attachMcpConnectChannelAction(params: {
  payloads: ReplyPayload[];
  action?: McpConnectAction;
}): ReplyPayload[] {
  const { action } = params;
  if (!action) {
    return params.payloads;
  }
  return attachChannelPresentation(params.payloads, () => ({
    blocks: [
      {
        type: "buttons",
        buttons: [
          {
            label: `Connect ${action.serverName}`,
            action: { type: "url", url: action.authorizationUrl },
          },
        ],
      },
    ],
  }));
}
