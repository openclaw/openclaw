import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { MarkdownRenderOptions } from "../../../components/markdown-render-options.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import { renderStreamGroupParts } from "./chat-message-stream.ts";
import { renderSidebarPanel } from "./chat-sidebar-content.ts";

const text =
  "Original ClawSweeper PR **#1558 merged**; Follow-up ClawSweeper PR **#1576 opened**; OpenClaw PR #1576.";
const context: MarkdownRenderOptions = {
  githubRepo: { owner: "openclaw", repo: "openclaw" },
  githubRepositories: [{ owner: "openclaw", repo: "clawsweeper", aliases: ["ClawSweeper"] }],
};

describe("GitHub reference presentation parity", () => {
  it.each(["persisted", "streaming"] as const)(
    "retains Enterprise references through the %s chat renderer",
    (surface) => {
      const enterprise: MarkdownRenderOptions = {
        githubRepo: { owner: "bic", repo: "lobster", host: "microsoft.ghe.com" },
      };
      const enterpriseText = "Read issue #17436 and PR #17420.";
      const container = document.createElement("div");
      const message = { role: "assistant", content: enterpriseText };
      render(
        surface === "streaming"
          ? renderStreamGroupParts(
              [
                {
                  kind: "stream",
                  key: "live",
                  text: enterpriseText,
                  isStreaming: true,
                  startedAt: 1,
                },
              ],
              enterprise,
              "standalone",
            )
          : renderGroupedMessage(prepareChatMessageRender(message), "reply", {
              ...enterprise,
              isStreaming: false,
              showReasoning: false,
            }),
        container,
      );
      expect(
        [...container.querySelectorAll<HTMLAnchorElement>("a.markdown-github-item")].map(
          (a) => a.href,
        ),
      ).toEqual([
        "https://microsoft.ghe.com/bic/lobster/issues/17436",
        "https://microsoft.ghe.com/bic/lobster/pull/17420",
      ]);
    },
  );

  it.each(["persisted", "streaming", "sidebar"] as const)(
    "uses per-reference identity in %s content",
    (surface) => {
      const container = document.createElement("div");
      const message = { role: "assistant", content: text };
      if (surface === "sidebar") {
        render(
          renderSidebarPanel({
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
          }),
          container,
        );
      } else if (surface === "streaming") {
        render(
          renderStreamGroupParts(
            [{ kind: "stream", key: "live", text, isStreaming: true, startedAt: 1 }],
            context,
            "standalone",
          ),
          container,
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
