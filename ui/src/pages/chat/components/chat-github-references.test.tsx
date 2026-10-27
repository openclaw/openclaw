import { describe, expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import { StreamGroupParts } from "./chat-message-stream-view.tsx";
import { SidebarPanel } from "./chat-sidebar-content.tsx";

const text =
  "PR openclaw/clawsweeper#1558; PR openclaw/clawsweeper#1576; PR openclaw/openclaw#1576; PR #1576.";

describe("GitHub reference presentation parity", () => {
  it.each(["persisted", "streaming", "sidebar"] as const)(
    "uses per-reference identity in %s content",
    (surface) => {
      const container = document.createElement("div");
      const message = { role: "assistant", content: text };
      if (surface === "sidebar") {
        mountSolid(
          () => (
            <SidebarPanel
              {...{
                content: { kind: "markdown", content: text },
                showingRawText: false,
                error: null,
                attachmentRuntime: {},
                onRetry() {},
                onClose() {},
                onViewRawText() {},
                onClick() {},
                onKeydown() {},
              }}
            />
          ),
          { container },
        );
      } else if (surface === "streaming") {
        mountSolid(
          () => (
            <StreamGroupParts
              parts={[{ kind: "stream", key: "live", text, isStreaming: true, startedAt: 1 }]}
              options={{}}
              presentation="standalone"
            />
          ),
          { container },
        );
      } else {
        mountSolid(
          () => (
            <GroupedMessage
              preparation={prepareChatMessageRender(message)}
              messageKey="reply"
              options={{ isStreaming: false, showReasoning: false }}
            />
          ),
          { container },
        );
      }
      expect(
        [...container.querySelectorAll<HTMLAnchorElement>("a.markdown-github-item")].map(
          (a) => a.href,
        ),
      ).toEqual([
        "https://github.com/openclaw/clawsweeper/pull/1558",
        "https://github.com/openclaw/clawsweeper/pull/1576",
        "https://github.com/openclaw/openclaw/pull/1576",
      ]);
    },
  );
});
