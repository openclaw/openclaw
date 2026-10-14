import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import { StreamGroupParts } from "./chat-message-stream-view.tsx";
import { SidebarPanel } from "./chat-sidebar-content.tsx";

const text =
  "Original ClawSweeper PR **#1558 merged**; Follow-up ClawSweeper PR **#1576 opened**; OpenClaw PR #1576.";
const context: MarkdownRenderOptions = {
  githubRepo: { owner: "openclaw", repo: "openclaw" },
  githubRepositories: [{ owner: "openclaw", repo: "clawsweeper", aliases: ["ClawSweeper"] }],
};

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
                ...context,
                content: { kind: "markdown", content: text },
                showingRawText: false,
                error: null,
                attachmentRuntime: {},
                onRetry() {},
                onClose() {},
                onViewRawText() {},
                onAttachmentUpdate() {},
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
              options={context}
              presentation="standalone"
            />
          ),
          { container },
        );
      } else {
        render(
          renderGroupedMessage(prepareChatMessageRender(message), "reply", {
            ...context,
            isStreaming: false,
            showReasoning: false,
          }),
          container,
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
