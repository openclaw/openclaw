/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { updateLinkReaderDisplay } from "../../../components/markdown-link-display.ts";
import { extractText } from "../../../lib/chat/message-extract.ts";
import type { ChatDisplayFacts, ChatRowDisplayFacts } from "../../../lib/chat/row-display-facts.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createProps } from "../chat-thread.test-support.ts";
import { buildCachedChatItems } from "../chat-thread.ts";
import { render } from "../test-helpers/chat-transcript-native.tsx";
import * as chatMessage from "./chat-message-group-frame.ts";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";
import { threadFixture } from "./chat-transcript-fixture.test-support.tsx";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
  transcriptMessage as msg,
  requireElement as required,
} from "./chat-transcript.test-support.ts";
const click = (root: ParentNode, selector: string) => required(root, selector).click();
const selectedSession = (props: ReturnType<typeof threadProps>) => ({
  key: props.sessionKey,
  kind: "direct" as const,
  updatedAt: 1,
});
function updatingThread(props: ReturnType<typeof threadProps>) {
  const fixture = threadFixture(props);
  return {
    ...fixture,
    rerender: () => {
      fixture.rerender();
      fixture.transcript.update();
    },
  };
}
beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);
describe("receipt fanout", () => {
  it("keeps unchanged tool work and disclosure state while dispatching current file actions", async () => {
    const first = msg(
      "assistant",
      [
        { type: "text", text: "Inspect the first file." },
        { type: "toolCall", id: "first", name: "read", arguments: { path: "src/first.ts" } },
      ],
      1_000,
      { __openclaw: { id: "first-call", runId: "tools" } },
    );
    const firstResult = msg("toolResult", "First output", 2_000, {
      toolCallId: "first",
      toolName: "read",
      __openclaw: { id: "first-result", runId: "tools" },
    });
    const second = msg(
      "assistant",
      [
        { type: "text", text: "Inspect the second file." },
        { type: "toolCall", id: "second", name: "read", arguments: { path: "src/second.ts" } },
      ],
      3_000,
      { __openclaw: { id: "second-call", runId: "tools" } },
    );
    const secondResult = msg("toolResult", "Second output", 4_000, {
      toolCallId: "second",
      toolName: "read",
      __openclaw: { id: "second-result", runId: "tools" },
    });
    const oldOpen = vi.fn();
    const newOpen = vi.fn();
    const prepare = vi.spyOn(chatMessage, "prepareGroupMessage");
    const props = threadProps(
      "current-tool-actions",
      "agent:main:direct:tool-actions",
      [first, firstResult, second, secondResult],
      {
        runId: "tools",
        runActive: true,
        runWorking: true,
        showToolCalls: true,
        onOpenWorkspaceFile: oldOpen,
      },
    );
    props.selectedSession = selectedSession(props);
    const { transcript, container, rerender } = updatingThread(props);
    onTestFinished(() => {
      render(null, container);
      transcript.dispose();
    });
    rerender();
    transcript.start();
    await settleToolBridges(container);
    const tools = () => [
      ...container.querySelectorAll<HTMLElement>(".chat-tool-msg-collapse--manual"),
    ];
    await waitForSolid(() => expect(tools()).toHaveLength(2));
    for (const tool of tools()) click(tool, ".chat-tool-row__toggle");
    await settleToolBridges(container);
    const firstTool = tools()[0]!;
    const firstToggle = required(firstTool, ".chat-tool-row__toggle");
    const firstLink = required(firstTool, ".chat-tool-card__detail-link");
    firstToggle.focus();
    firstLink.click();
    expect(oldOpen).toHaveBeenCalledWith(expect.objectContaining({ path: "src/first.ts" }));
    const firstPreparations = () =>
      prepare.mock.calls.filter(([, item]) =>
        extractToolCardsCached(item.message).some((card) => card.callId === "first"),
      ).length;
    const preparedBefore = firstPreparations();
    expect(preparedBefore).toBeGreaterThan(0);
    props.onOpenWorkspaceFile = newOpen;
    props.messages = [
      first,
      firstResult,
      second,
      { ...secondResult, content: "Second output updated" },
    ];
    rerender();
    await settleToolBridges(container);
    await waitForSolid(() => expect(tools()[1]?.textContent).toContain("Second output updated"));
    expect(firstPreparations()).toBe(preparedBefore);
    expect(tools()[0]).toBe(firstTool);
    expect(required(firstTool, ".chat-tool-row__toggle")).toBe(firstToggle);
    expect(document.activeElement).toBe(firstToggle);
    expect(firstToggle.getAttribute("aria-expanded")).toBe("true");
    firstLink.click();
    expect(newOpen).toHaveBeenCalledWith(expect.objectContaining({ path: "src/first.ts" }));
    expect(oldOpen).toHaveBeenCalledOnce();
    const displayedSource = expectDefined(
      prepare.mock.calls.find(([, item]) =>
        extractToolCardsCached(item.message).some((card) => card.callId === "first"),
      ),
      "displayed first tool",
    )[1];
    const firstCard = expectDefined(
      extractToolCardsCached(displayedSource.message).find((card) => card.callId === "first"),
      "retained first result",
    );
    firstCard.isError = true;
    rerender();
    await settleToolBridges(container);
    await waitForSolid(() =>
      expect(required(firstTool, ".chat-tool-card__outcome").textContent).toContain("failed"),
    );
    expect(firstPreparations()).toBeGreaterThan(preparedBefore);
    props.onOpenWorkspaceFile = undefined;
    rerender();
    await settleToolBridges(container);
    await waitForSolid(() =>
      expect(container.querySelector(".chat-tool-card__detail-link")).toBeNull(),
    );
    expect(container.querySelector(".chat-tool-row__file-link")).toBeNull();
    firstLink.click();
    expect(newOpen).toHaveBeenCalledOnce();
  });

  it("keeps retained link facts attached to the current same-scope display owner", async () => {
    const url = "https://github.com/example/project/pull/42";
    let facts: ChatRowDisplayFacts = {
      links: {
        [`pr:${url}`]: { title: "Synthetic change", badge: { label: "Open", tone: "positive" } },
      },
    };
    const oldWrite = vi.fn();
    const newWrite = vi.fn((update: Partial<ChatRowDisplayFacts>) => {
      facts = { ...facts, ...update };
    });
    const displayOwner = (
      write: (update: Partial<ChatRowDisplayFacts>) => void,
      scope = "same-owner-scope",
    ): ChatDisplayFacts => ({
      forRow: (id) =>
        id ? { read: () => ({ scope: `${scope}:${id}`, facts }), write } : undefined,
    });
    const first = msg("assistant", url, 1_000, {
      __openclaw: { id: "linked-answer", runId: "links" },
    });
    const second = msg("assistant", "Still working.", 2_000, {
      __openclaw: { id: "later-answer", runId: "links" },
    });
    const props = threadProps(
      "current-display-owner",
      "agent:main:direct:display-owner",
      [first, second],
      {
        runId: "links",
        runActive: true,
        displayFacts: displayOwner(oldWrite),
      },
    );
    const { transcript, container, rerender } = updatingThread(props);
    onTestFinished(() => {
      render(null, container);
      transcript.dispose();
    });
    rerender();
    transcript.start();
    const link = await waitForSolid(() => required(container, "a.markdown-github-item"));
    expect(link.getAttribute("aria-description")).toBe("Open");
    props.displayFacts = displayOwner(newWrite);
    props.messages = [first, { ...second, content: "Later answer updated." }];
    rerender();
    await waitForSolid(() => expect(container.textContent).toContain("Later answer updated."));
    expect(required(container, "a.markdown-github-item")).toBe(link);
    updateLinkReaderDisplay(link, {
      url,
      title: "Synthetic change",
      badge: { label: "Merged", tone: "accent" },
    });
    expect(oldWrite).not.toHaveBeenCalled();
    expect(newWrite).toHaveBeenCalledOnce();
    expect(facts.links?.[`pr:${url}`]?.badge?.label).toBe("Merged");
    facts = {
      links: {
        [`pr:${url}`]: { title: "Current owner", badge: { label: "Closed", tone: "neutral" } },
      },
    };
    updateLinkReaderDisplay(link);
    expect(link.getAttribute("aria-description")).toBe("Closed");
    const differentScopeWrite = vi.fn();
    props.displayFacts = displayOwner(differentScopeWrite, "different-session");
    rerender();
    await flushDeferredRowPrune();
    updateLinkReaderDisplay(link, {
      url,
      title: "Stale completion",
      badge: { label: "Open", tone: "positive" },
    });
    expect(differentScopeWrite).not.toHaveBeenCalled();
    props.displayFacts = undefined;
    rerender();
    await flushDeferredRowPrune();
    updateLinkReaderDisplay(link, {
      url,
      title: "Synthetic change",
      badge: { label: "Closed", tone: "neutral" },
    });
    expect(newWrite).toHaveBeenCalledOnce();
  });

  it("retains narration while a sibling tool result changes", () => {
    const history = msg(
      "assistant",
      [
        { type: "text", text: "First narration" },
        { type: "toolCall", id: "first", name: "exec", arguments: {} },
      ],
      1_000,
      { runId: "tools" },
    );
    const result = (content: string) =>
      msg("toolResult", content, 2_000, { toolCallId: "first", toolName: "exec", runId: "tools" });
    const input = createProps({
      messages: [msg("user", "Run tools", 500), history],
      toolMessages: [result("old output")],
    });
    const narration = (items: ReturnType<typeof buildCachedChatItems>) =>
      items
        .flatMap((item) => (item.kind === "group" ? item.messages : []))
        .find((item) => extractText(item.message) === "First narration")?.message;
    const initial = narration(buildCachedChatItems(input));
    expect(initial).toBeDefined();
    expect(
      narration(buildCachedChatItems({ ...input, toolMessages: [result("new output")] })),
    ).toBe(initial);
  });
});
