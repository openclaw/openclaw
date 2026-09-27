// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { coalesceToolActivityMessages } from "./chat-tool-activity-coalesce.ts";

describe("tool activity preparation invalidation", () => {
  it.each(["array", "blocks", "empty"] as const)(
    "refreshes reused messages after replacing their %s content",
    (replacement) => {
      const callBlock = (command: string) => ({
        type: "toolCall",
        id: "call",
        name: "exec",
        arguments: { command },
      });
      const call = {
        role: "assistant",
        runId: "run",
        content: replacement === "empty" ? [] : [callBlock("before")],
      };
      const result = {
        role: "toolResult",
        runId: "run",
        toolCallId: "call",
        toolName: "exec",
        content: [{ type: "text", text: "before result" }],
      };
      const items: ChatItem[] = [
        { kind: "message", key: "call", message: call },
        { kind: "message", key: "result", message: result },
      ];
      const cards = () =>
        coalesceToolActivityMessages(items).flatMap((item) =>
          item.kind === "message" ? extractToolCardsCached(item.message) : [],
        );
      expect(cards()).toMatchObject([{ outputText: "before result" }]);

      if (replacement === "array") {
        call.content = [callBlock("after")];
        result.content = [{ type: "text", text: "after result" }];
      } else {
        call.content.splice(0, call.content.length, callBlock("after"));
        result.content.splice(0, 1, { type: "text", text: "after result" });
      }

      expect(cards()).toMatchObject([
        { args: { command: "after" }, outputText: "after result", completed: true },
      ]);
      expect(cards()).toMatchObject([
        { args: { command: "after" }, outputText: "after result", completed: true },
      ]);
    },
  );
});
