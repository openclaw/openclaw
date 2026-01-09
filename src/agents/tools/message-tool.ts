import { Type } from "@sinclair/typebox";

import {
  sendMessage,
  sendPoll,
  type MessagePollResult,
  type MessageSendResult,
} from "../../infra/outbound/message.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";

const MessageToolSchema = Type.Object({
  action: Type.Union([Type.Literal("send"), Type.Literal("poll")]),
  to: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  mediaUrl: Type.Optional(Type.String()),
  gifPlayback: Type.Optional(Type.Boolean()),
  provider: Type.Optional(Type.String()),
  accountId: Type.Optional(Type.String()),
  dryRun: Type.Optional(Type.Boolean()),
  bestEffort: Type.Optional(Type.Boolean()),
  question: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(Type.String())),
  maxSelections: Type.Optional(Type.Number()),
  durationHours: Type.Optional(Type.Number()),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});

export function createMessageTool(): AnyAgentTool {
  return {
    label: "Message",
    name: "message",
    description:
      "Send messages and polls across providers (send/poll). Prefer this for general outbound messaging.",
    parameters: MessageToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gateway = {
        url: readStringParam(params, "gatewayUrl", { trim: false }),
        token: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs: readNumberParam(params, "timeoutMs"),
        clientName: "agent" as const,
        mode: "agent" as const,
      };
      const dryRun = Boolean(params.dryRun);

      if (action === "send") {
        const to = readStringParam(params, "to", { required: true });
        const content = readStringParam(params, "content", {
          required: true,
          allowEmpty: true,
        });
        const mediaUrl = readStringParam(params, "mediaUrl", { trim: false });
        const provider = readStringParam(params, "provider");
        const accountId = readStringParam(params, "accountId");
        const gifPlayback =
          typeof params.gifPlayback === "boolean" ? params.gifPlayback : false;
        const bestEffort =
          typeof params.bestEffort === "boolean" ? params.bestEffort : undefined;

        const result: MessageSendResult = await sendMessage({
          to,
          content,
          mediaUrl: mediaUrl || undefined,
          provider: provider || undefined,
          accountId: accountId || undefined,
          gifPlayback,
          dryRun,
          bestEffort,
          gateway,
        });
        return jsonResult(result);
      }

      if (action === "poll") {
        const to = readStringParam(params, "to", { required: true });
        const question = readStringParam(params, "question", { required: true });
        const options =
          readStringArrayParam(params, "options", { required: true }) ?? [];
        const maxSelections = readNumberParam(params, "maxSelections", {
          integer: true,
        });
        const durationHours = readNumberParam(params, "durationHours", {
          integer: true,
        });
        const provider = readStringParam(params, "provider");

        const result: MessagePollResult = await sendPoll({
          to,
          question,
          options,
          maxSelections,
          durationHours,
          provider: provider || undefined,
          dryRun,
          gateway,
        });
        return jsonResult(result);
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
