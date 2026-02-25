/**
 * Inbox Tool
 * Reads pending messages from teammates via file-based inbox
 */

import { Type } from "@sinclair/typebox";
import { readInboxMessages, clearInboxMessages } from "../../../teams/inbox.js";
import { validateTeamNameOrThrow } from "../../../teams/storage.js";
import type { AnyAgentTool } from "../common.js";
import { jsonResult, readStringParam } from "../common.js";

const InboxSchema = Type.Object({
  team_name: Type.String({ minLength: 1, maxLength: 50 }),
  clear: Type.Optional(Type.Boolean()),
});

type InboxMessage = {
  id: string;
  type: string;
  from: string;
  to?: string;
  content?: string;
  summary?: string;
  timestamp?: number;
  requestId?: string;
  approve?: boolean;
  reason?: string;
};

function formatMessageSummary(msg: InboxMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: msg.id,
    type: msg.type,
    from: msg.from,
  };

  if (msg.summary) {
    result.summary = msg.summary;
  } else if (msg.content) {
    const words = msg.content.trim().split(/\s+/);
    result.summary = words.length <= 10 ? msg.content : words.slice(0, 10).join(" ") + "...";
  }

  if (msg.timestamp) {
    result.timestamp = msg.timestamp;
  }

  if (msg.requestId) {
    result.request_id = msg.requestId;
  }

  if (msg.type === "shutdown_response") {
    result.approve = msg.approve;
    if (msg.reason) {
      result.reason = msg.reason;
    }
  }

  return result;
}

export function createInboxTool(opts?: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Inbox",
    name: "inbox",
    description:
      "Read pending messages from teammates. Returns message summaries and optionally clears the inbox after reading.",
    parameters: InboxSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      const teamName = readStringParam(params, "team_name", { required: true });
      const clear = params.clear !== false;

      validateTeamNameOrThrow(teamName);

      const teamsDir = process.env.OPENCLAW_STATE_DIR || process.cwd();
      const sessionKey = opts?.agentSessionKey;

      if (!sessionKey) {
        return jsonResult({
          error: "No session key available. This tool requires an active agent session.",
        });
      }

      const messages = await readInboxMessages(teamName, teamsDir, sessionKey);

      if (clear && messages.length > 0) {
        await clearInboxMessages(teamName, teamsDir, sessionKey);
      }

      return jsonResult({
        count: messages.length,
        messages: messages.map((msg) => formatMessageSummary(msg as InboxMessage)),
      });
    },
  };
}
