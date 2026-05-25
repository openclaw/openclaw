import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";
import { callGatewayTool, readGatewayCallOptions, type GatewayCallOptions } from "./gateway.js";

const SLACK_CHANNEL_ID = "slack";

const SLACK_TOOL_ACTIONS = [
  "react",
  "reactions",
  "sendMessage",
  "editMessage",
  "deleteMessage",
  "readMessages",
  "pinMessage",
  "unpinMessage",
  "listPins",
  "memberInfo",
  "emojiList",
  "uploadFile",
  "downloadFile",
] as const;

type SlackToolAction = (typeof SLACK_TOOL_ACTIONS)[number];

const SlackToolSchema = Type.Object(
  {
    action: stringEnum(SLACK_TOOL_ACTIONS, {
      description: "Slack action to invoke. Mirrors the verbs documented in skills/slack/SKILL.md.",
    }),
    accountId: Type.Optional(
      Type.String({ description: "Slack account id when multiple accounts are configured." }),
    ),
    channelId: Type.Optional(
      Type.String({ description: "Slack channel id (e.g. C123) for channel-scoped actions." }),
    ),
    to: Type.Optional(
      Type.String({
        description:
          'Send target ("channel:<id>", "user:<id>", or a bare channel id) for sendMessage/uploadFile.',
      }),
    ),
    messageId: Type.Optional(
      Type.String({ description: "Slack message timestamp, e.g. 1712023032.1234." }),
    ),
    threadTs: Type.Optional(
      Type.String({ description: "Thread root timestamp for threaded sends/uploads." }),
    ),
    threadId: Type.Optional(
      Type.String({ description: "Thread id used by readMessages and downloadFile." }),
    ),
    content: Type.Optional(
      Type.String({ description: "Message body for sendMessage/editMessage." }),
    ),
    emoji: Type.Optional(
      Type.String({
        description: "Reaction emoji name (Unicode or :name:). Required when adding a reaction.",
      }),
    ),
    remove: Type.Optional(
      Type.Boolean({ description: "Set true to remove a reaction instead of adding it." }),
    ),
    userId: Type.Optional(Type.String({ description: "Slack user id for memberInfo." })),
    fileId: Type.Optional(Type.String({ description: "Slack file id for downloadFile." })),
    filePath: Type.Optional(
      Type.String({
        description: "Local file path to upload (uploadFile only).",
      }),
    ),
    initialComment: Type.Optional(
      Type.String({ description: "Optional comment to send with an uploaded file." }),
    ),
    filename: Type.Optional(Type.String({ description: "Override filename for uploadFile." })),
    title: Type.Optional(Type.String({ description: "Override title for uploadFile." })),
    limit: Type.Optional(
      Type.Number({ description: "Result limit for readMessages/reactions/emojiList." }),
    ),
    before: Type.Optional(Type.String({ description: "Read messages before this timestamp." })),
    after: Type.Optional(Type.String({ description: "Read messages after this timestamp." })),
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

type SlackGatewayCall = (params: {
  channel: string;
  action: string;
  params: Record<string, unknown>;
  accountId?: string;
  idempotencyKey: string;
}) => Promise<unknown>;

export type SlackToolDeps = {
  callGatewayTool?: typeof callGatewayTool;
  randomId?: () => string;
};

function pickDefined(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      out[key] = entry;
    }
  }
  return out;
}

function buildSlackActionRequest(
  action: SlackToolAction,
  params: Record<string, unknown>,
): { agnosticAction: string; actionParams: Record<string, unknown> } {
  const channelId = readStringParam(params, "channelId");
  const messageId = readStringParam(params, "messageId");
  const to = readStringParam(params, "to");
  const threadTs = readStringParam(params, "threadTs");
  const threadId = readStringParam(params, "threadId");

  switch (action) {
    case "react": {
      if (!channelId) {
        throw new Error("channelId required");
      }
      if (!messageId) {
        throw new Error("messageId required");
      }
      const remove = typeof params.remove === "boolean" ? params.remove : undefined;
      return {
        agnosticAction: "react",
        actionParams: pickDefined({
          channelId,
          messageId,
          emoji: readStringParam(params, "emoji", { allowEmpty: true }),
          ...(remove !== undefined ? { remove } : {}),
        }),
      };
    }
    case "reactions": {
      if (!channelId) {
        throw new Error("channelId required");
      }
      if (!messageId) {
        throw new Error("messageId required");
      }
      return {
        agnosticAction: "reactions",
        actionParams: pickDefined({
          channelId,
          messageId,
          limit: readNumberParam(params, "limit", { integer: true }),
        }),
      };
    }
    case "sendMessage": {
      const target = to ?? channelId;
      if (!target) {
        throw new Error("to or channelId required");
      }
      const content = readStringParam(params, "content", { allowEmpty: true });
      return {
        agnosticAction: "send",
        actionParams: pickDefined({
          to: target,
          message: content,
          threadId: threadTs ?? threadId,
        }),
      };
    }
    case "editMessage": {
      if (!channelId) {
        throw new Error("channelId required");
      }
      if (!messageId) {
        throw new Error("messageId required");
      }
      const content = readStringParam(params, "content", { allowEmpty: true });
      return {
        agnosticAction: "edit",
        actionParams: pickDefined({ channelId, messageId, message: content }),
      };
    }
    case "deleteMessage": {
      if (!channelId) {
        throw new Error("channelId required");
      }
      if (!messageId) {
        throw new Error("messageId required");
      }
      return {
        agnosticAction: "delete",
        actionParams: { channelId, messageId },
      };
    }
    case "readMessages": {
      if (!channelId) {
        throw new Error("channelId required");
      }
      return {
        agnosticAction: "read",
        actionParams: pickDefined({
          channelId,
          limit: readNumberParam(params, "limit", { integer: true }),
          before: readStringParam(params, "before"),
          after: readStringParam(params, "after"),
          threadId,
        }),
      };
    }
    case "pinMessage": {
      if (!channelId) {
        throw new Error("channelId required");
      }
      if (!messageId) {
        throw new Error("messageId required");
      }
      return {
        agnosticAction: "pin",
        actionParams: { channelId, messageId },
      };
    }
    case "unpinMessage": {
      if (!channelId) {
        throw new Error("channelId required");
      }
      if (!messageId) {
        throw new Error("messageId required");
      }
      return {
        agnosticAction: "unpin",
        actionParams: { channelId, messageId },
      };
    }
    case "listPins": {
      if (!channelId) {
        throw new Error("channelId required");
      }
      return {
        agnosticAction: "list-pins",
        actionParams: { channelId },
      };
    }
    case "memberInfo": {
      const userId = readStringParam(params, "userId", { required: true });
      return {
        agnosticAction: "member-info",
        actionParams: { userId },
      };
    }
    case "emojiList": {
      return {
        agnosticAction: "emoji-list",
        actionParams: pickDefined({
          limit: readNumberParam(params, "limit", { integer: true }),
        }),
      };
    }
    case "uploadFile": {
      const target = to ?? channelId;
      if (!target) {
        throw new Error("to or channelId required");
      }
      const filePath = readStringParam(params, "filePath", { required: true, trim: false });
      return {
        agnosticAction: "upload-file",
        actionParams: pickDefined({
          to: target,
          filePath,
          initialComment: readStringParam(params, "initialComment", { allowEmpty: true }),
          filename: readStringParam(params, "filename"),
          title: readStringParam(params, "title"),
          threadId: threadTs ?? threadId,
        }),
      };
    }
    case "downloadFile": {
      const fileId = readStringParam(params, "fileId", { required: true });
      return {
        agnosticAction: "download-file",
        actionParams: pickDefined({ fileId, channelId, threadId }),
      };
    }
    default: {
      const exhaustive: never = action;
      throw new Error(`Unsupported slack action: ${exhaustive as string}`);
    }
  }
}

export const SLACK_TOOL_DISPLAY_SUMMARY = "Bridge to the Slack channel plugin's actions.";

export function createSlackTool(deps?: SlackToolDeps): AnyAgentTool {
  const callGateway = deps?.callGatewayTool ?? callGatewayTool;
  const newId = deps?.randomId ?? (() => randomUUID());
  return {
    label: "Slack",
    name: "slack",
    displaySummary: SLACK_TOOL_DISPLAY_SUMMARY,
    description: `Invoke Slack channel actions through the Gateway. Action names match skills/slack/SKILL.md.

Routes through the gateway message.action method, which dispatches to the Slack channel plugin and uses the configured Slack account credentials. Requires channels.slack to be configured. The tool only exposes the action surface advertised by skills/slack/SKILL.md and does not unlock admin-token operations such as conversations.create or apps.manifest.create.

Common parameters: channelId (e.g. C123), messageId (Slack message timestamp), to ("channel:<id>" / "user:<id>" / bare id), content (message body), emoji (Unicode or :name:), threadTs (thread root timestamp).

Examples:
- React: { "action": "react", "channelId": "C123", "messageId": "1712023032.1234", "emoji": "✅" }
- Send: { "action": "sendMessage", "to": "channel:C123", "content": "Hello" }
- Read: { "action": "readMessages", "channelId": "C123", "limit": 20 }
- Pin:  { "action": "pinMessage", "channelId": "C123", "messageId": "1712023032.1234" }`,
    parameters: SlackToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true }) as SlackToolAction;
      if (!SLACK_TOOL_ACTIONS.includes(action)) {
        throw new Error(`Unknown slack action: ${action}`);
      }
      const accountId = readStringParam(params, "accountId");
      const { agnosticAction, actionParams } = buildSlackActionRequest(action, params);
      const gatewayOpts: GatewayCallOptions = {
        ...readGatewayCallOptions(params),
        timeoutMs:
          typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
            ? params.timeoutMs
            : 60_000,
      };
      const callable: SlackGatewayCall = async (request) =>
        await callGateway("message.action", gatewayOpts, request);
      const result = await callable({
        channel: SLACK_CHANNEL_ID,
        action: agnosticAction,
        params: actionParams,
        ...(accountId ? { accountId } : {}),
        idempotencyKey: newId(),
      });
      return jsonResult(result);
    },
  };
}
