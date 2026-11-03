import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { githubTextReferenceSnapshot } from "../../../../../extensions/github-repositories/browser/text-reference-api.ts";
import { prepareChatMessageRender } from "../../../lib/chat/message-display.ts";
import { githubReferenceOptions } from "../../../test-helpers/github-text-references.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { StreamGroupParts } from "./chat-message-stream-view.tsx";
import { SidebarPanel } from "./chat-sidebar-content.tsx";
import { threadFixture } from "./chat-transcript-fixture.test-support.tsx";
import {
  threadProps,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

const text =
  "Original ClawSweeper PR **#1558 merged**; Follow-up ClawSweeper PR **#1576 opened**; OpenClaw PR #1576.";
const context = githubReferenceOptions({
  githubRepo: { owner: "openclaw", repo: "openclaw" },
  githubRepositories: [{ owner: "openclaw", repo: "clawsweeper", aliases: ["ClawSweeper"] }],
});

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
                textReferences: context.textReferences,
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
              options={context}
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
              options={{ ...context, isStreaming: false, showReasoning: false }}
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

describe("GitHub transcript reference snapshots", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);
  it("updates persisted named references when the connection catalog changes without transcript edits", () => {
    const repository = { owner: "openclaw", repo: "openclaw" };
    const props = threadProps("pane-named", "agent:main:named", [
      { role: "assistant", content: "ClawSweeper PR **#1576 opened**", timestamp: 1_000 },
    ]);
    props.textReferences = [githubTextReferenceSnapshot(repository)];
    const { container, rerender } = threadFixture(props);
    const chip = () => container.querySelector<HTMLAnchorElement>("a.markdown-github-item");
    rerender();
    expect(chip()).toBeNull();
    props.textReferences = [
      githubTextReferenceSnapshot(repository, [
        { owner: "openclaw", repo: "clawsweeper", aliases: ["ClawSweeper"] },
      ]),
    ];
    rerender();
    expect(chip()?.href).toBe("https://github.com/openclaw/clawsweeper/pull/1576");
    props.textReferences = [
      githubTextReferenceSnapshot(repository, [{ aliases: ["ClawSweeper"] }]),
    ];
    rerender();
    expect(chip()).toBeNull();
    props.textReferences = [
      githubTextReferenceSnapshot(repository, [
        { owner: "fork", repo: "clawsweeper", aliases: ["ClawSweeper"] },
      ]),
    ];
    rerender();
    expect(chip()?.href).toBe("https://github.com/fork/clawsweeper/pull/1576");
  });

  it("updates settled GitHub reference chips when the session repository arrives or changes", () => {
    vi.spyOn(Date, "now").mockReturnValue(60_000);
    const props = threadProps("pane-github-repository", "agent:main:github-repository", [
      { role: "assistant", content: "PR #141270", timestamp: 1_000 },
    ]);
    const { container, rerender } = threadFixture(props);
    const chip = () => container.querySelector<HTMLAnchorElement>("a.markdown-github-item");
    rerender();
    expect(chip()).toBeNull();

    props.textReferences = [
      { ...githubTextReferenceSnapshot({ owner: "openclaw", repo: "openclaw" }), key: "same" },
    ];
    rerender();
    expect(chip()?.href).toBe("https://github.com/openclaw/openclaw/pull/141270");
    props.textReferences = [
      { ...githubTextReferenceSnapshot({ owner: "other", repo: "checkout" }), key: "same" },
    ];
    rerender();
    expect(chip()?.href).toBe("https://github.com/other/checkout/pull/141270");
    props.textReferences = [];
    rerender();
    expect(chip()).toBeNull();
  });
});
