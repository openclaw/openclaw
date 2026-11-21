import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import {
  persistSessionTranscriptTurn as persistTurn,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readRecentUserAssistantTextForSession as readText } from "../../config/sessions/transcript.js";
import { persistUserTurnTranscript } from "../../sessions/user-turn-transcript.persistence.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { mergeSessionTranscriptContext } from "./session-transcript-context.runtime.js";

const dirs = useSessionStoreTempDirs(afterAll, "reaction-pending-context-");

it.each([
  ["confirmed", "settled", true, false, false],
  ["media-only-followup", "settled", true, false, false],
  ["media-edited", "settled", true, false, true],
  ["recent-window", "settled", true, false, false],
  ["off-source", "settled", false, false, true],
  ["partial", "settled", true, true, true],
  ["failed", "failed", true, false, true],
  ["presentation-error", "settled", true, false, false],
  ["non-messaging", "settled", true, false, true],
] as const)(
  "retains only pending requests after a %s reaction",
  async (label, status, sourceReplyDelivered, partialDelivery, pending) => {
    const scope = {
      agentId: "main",
      sessionId: label,
      sessionKey: "agent:main:main",
      storePath: path.join(dirs.make(), "sessions.json"),
    };
    const sessionEntry = { sessionId: label, chatType: "group" as const, updatedAt: 1 };
    await replaceSessionEntry(scope, sessionEntry);
    const user = (text: string, messageId: string, timestamp: number) =>
      persistUserTurnTranscript({
        ...scope,
        sessionEntry,
        input: { text, timestamp, transport: { channel: "whatsapp", messageId } },
      });
    await user("An earlier unresolved request.", "unresolved", 500);
    await user("Please react to this message.", "old-request", 1000);
    await persistTurn(scope, {
      updateMode: "none",
      messages: [
        {
          message: {
            role: "assistant",
            stopReason: "toolUse",
            timestamp: 2000,
            content: [
              {
                type: "toolCall",
                id: "reaction",
                name: "message",
                arguments: { action: "react", emoji: "👍", final: true, messageId: "old-request" },
              },
            ],
          },
        },
        {
          message: {
            role: "toolResult",
            toolName: label === "non-messaging" ? "exec" : "message",
            isError: label === "presentation-error",
            toolCallId: "reaction",
            timestamp: 3000,
            content: [
              {
                type: "text",
                text:
                  label === "presentation-error"
                    ? "Presentation failed after delivery"
                    : '{"ok":true}',
              },
            ],
            details: {
              messageDelivery: {
                status,
                partialDelivery,
                createdThreadIds: [],
                sourceReplyDelivered,
              },
            },
          },
        },
      ],
    });
    await user("An unanswered follow-up.", "followup", 3500);
    if (label === "media-only-followup") {
      await persistTurn(scope, {
        updateMode: "none",
        messages: [
          {
            message: {
              role: "user",
              timestamp: 3600,
              content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
              __openclaw: { transport: { channel: "whatsapp", messageId: "image" } },
            },
          },
          {
            message: {
              role: "assistant",
              timestamp: 3700,
              content: "Image received.",
              stopReason: "stop",
            },
          },
        ],
      });
    }
    const ctx: FinalizedMsgContext = {
      Body: "Thanks",
      RawBody: "Thanks",
      CommandBody: "Thanks",
      AgentId: scope.agentId,
      SessionKey: scope.sessionKey,
      Provider: "whatsapp",
      ChatType: "group",
      Timestamp: 4000,
      CommandAuthorized: false,
      SessionTranscriptContext: {
        historyLimit: 20,
        ...(label === "recent-window" ? { historyKind: "recent" as const } : {}),
      },
      InboundHistory: [
        {
          sender: "User",
          body: "An earlier unresolved request.",
          messageId: "unresolved",
          timestamp: 500,
        },
        {
          sender: "User",
          body: "An unanswered follow-up.",
          messageId: "followup",
          timestamp: 3500,
        },
        {
          sender: "User",
          body: "Please react to this message.",
          messageId: "old-request",
          timestamp: 1000,
          ...(label === "media-edited"
            ? { media: [{ url: "media://changed.png", contentType: "image/png" }] }
            : {}),
        },
      ],
    };
    await mergeSessionTranscriptContext({ ...scope, ctx });
    const prompt = buildInboundUserContextPrefix(ctx);
    expect(prompt.includes("Please react to this message.")).toBe(pending);
    expect(prompt).toContain("An earlier unresolved request.");
    expect(prompt).toContain("An unanswered follow-up.");
    const visible = await readText({ ...scope, includeMessageToolSourceReplies: true });
    expect(visible).toHaveLength(label === "media-only-followup" ? 4 : 3);
    expect(visible.every((entry) => entry.text.length > 0)).toBe(true);
    expect(visible.some((entry) => "hasCompletedAnswer" in entry)).toBe(false);
  },
);
