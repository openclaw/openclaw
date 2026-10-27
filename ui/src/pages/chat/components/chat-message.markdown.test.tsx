/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createChatMessageHarness,
  type RenderMessageGroupOptions,
} from "./chat-message-render.test-support.tsx";
import {
  createAssistantMessage,
  createMessageGroup,
  type TestMessage,
  type TestMessageEntry,
} from "./chat-message.test-support.ts";

const harness = createChatMessageHarness();
const {
  render,
  requireElement,
  element,
  elements,
  elementText,
  expectCount,
  expectAbsent,
  renderTestMessageGroup,
  renderAssistantMessage,
  renderAssistantMessages,
  renderMarkdownHtml,
  renderStreamingMarkdown,
  markdownRenderMock,
  streamingMarkdownRenderMock,
} = harness;

describe("grouped chat rendering", () => {
  function renderMarkdownAssistant(content: unknown) {
    markdownRenderMock.withImplementation(renderMarkdownHtml, () => {
      renderAssistantMessage(createAssistantMessage(content));
    });
  }

  function renderAssistantMessageEntries(
    entries: TestMessageEntry[],
    opts: Partial<RenderMessageGroupOptions> = {},
  ) {
    const group = createMessageGroup(entries[0]?.message, "assistant", {
      key: "assistant-group",
      messages: entries,
      timestamp: Date.now(),
    });
    render(renderTestMessageGroup(group, opts));
  }

  it("preserves reference links and one duplicate badge in recovered media", async () => {
    const fullText =
      "[Before][proof]\n\nMEDIA:https://example.com/comparison.png\n\n[After][proof]\n\n[proof]: https://example.com/proof";
    const fullMessage = createAssistantMessage(fullText, { timestamp: 1000 });
    const message = createAssistantMessage("Loading preview", {
      timestamp: 1000,
      __openclaw: { id: "media-recovery", seq: 1, truncated: true },
    });
    markdownRenderMock.withImplementation(renderMarkdownHtml, () => {
      renderAssistantMessageEntries([{ key: "media-order", message, duplicateCount: 2 }], {
        sessionKey: "agent:main:main",
        loadFullAssistantMessage: async () => null,
        getAssistantMessageExpansion: () => ({
          status: "loaded",
          markdown: fullText,
          message: fullMessage,
          revision: 1,
        }),
        onToggleAssistantMessageExpanded: vi.fn(),
      });
    });
    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(
        elements(".chat-text a, .chat-message-image").map((node) =>
          node instanceof HTMLImageElement ? "image" : node.textContent,
        ),
      ).toEqual(["Before", "image", "After"]),
    );
    expect(elements<HTMLAnchorElement>(".chat-text a").map((link) => link.href)).toEqual([
      "https://example.com/proof",
      "https://example.com/proof",
    ]);
    expectCount(".chat-duplicate-count", 1);
    expect(harness.view.textContent).not.toContain("Loading preview");
  });

  it("keeps list structure and its duplicate suffix across an assistant image", async () => {
    markdownRenderMock.withImplementation(renderMarkdownHtml, () => {
      renderAssistantMessageEntries([
        {
          key: "list-image",
          duplicateCount: 2,
          message: createAssistantMessage(
            "1. First\nMEDIA:https://example.com/first.png\n1. Second",
          ),
        },
      ]);
    });
    const list = requireElement(".chat-text ol", HTMLOListElement);
    expect(list.querySelectorAll(":scope > li")).toHaveLength(2);
    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(list.querySelector("li:first-child .chat-message-image")).not.toBeNull(),
    );
    expect(list.querySelector("li:last-child")?.textContent).toBe("Second\u00a0×2");
    expect(list.querySelector("li:last-child > .chat-duplicate-count")?.textContent).toBe("×2");
  });

  it("suppresses a whole thinking region spanning assistant media", async () => {
    renderMarkdownAssistant([
      { type: "text", text: "<thinking>Hidden before" },
      { type: "image", url: "https://example.com/hidden-before.png" },
      { type: "text", text: "Hidden middle" },
      { type: "image", url: "https://example.com/hidden-after.png" },
      { type: "text", text: "Hidden after</thinking>\n\nVisible answer" },
    ]);
    expect(elementText(".chat-text")?.trim()).toBe("Visible answer");
    await vi.dynamicImportSettled();
    await waitForSolid(() => expectCount(".chat-message-image", 0));
  });

  it("keeps literal media-marker text distinct from assistant image positions", async () => {
    renderMarkdownAssistant(
      "Literal OPENCLAWMEDIASLOT0END\n\nMEDIA:https://example.com/real.png\n\nDone",
    );
    expect(harness.view.textContent).toContain("Literal OPENCLAWMEDIASLOT0END");
    expect(harness.view.textContent).not.toContain("OPENCLAWMEDIASLOTX");
    await vi.dynamicImportSettled();
    await waitForSolid(() => expectCount(".chat-message-image", 1));
  });

  it("keeps an inline image mounted while the following paragraph streams and completes", async () => {
    const renderTurn = (tail: string, isStreaming: boolean) => {
      const message = createAssistantMessage(
        `**Before**\nMEDIA:https://example.com/stream.png\n\n${tail}`,
        { timestamp: 1000 },
      );
      render(
        renderTestMessageGroup(
          createMessageGroup(message, "assistant", { key: "stream-media", isStreaming }),
        ),
      );
    };
    await markdownRenderMock.withImplementation(renderMarkdownHtml, async () => {
      await streamingMarkdownRenderMock.withImplementation(renderStreamingMarkdown, async () => {
        renderTurn("Checking", true);
        await vi.dynamicImportSettled();
        const image = await waitForSolid(() =>
          requireElement(".chat-message-image", HTMLImageElement),
        );
        expect(requireElement(".chat-bubble", HTMLElement).classList.contains("fade-in")).toBe(
          false,
        );
        expect(requireElement(".chat-group", HTMLElement).dataset.chatRowKey).toBeTruthy();
        renderTurn("Checking the result.", true);
        expect(element(".chat-message-image")).toBe(image);
        renderTurn("Checking the result.", false);
        expect(element(".chat-message-image")).toBe(image);
        expect(elementText(".chat-text")).toContain("Checking the result.");
      });
    });
  });

  it("uses the visible caption direction when an assistant image comes first", () => {
    renderMarkdownAssistant(
      "MEDIA:https://example.com/preview.png\n\n<thinking>Hidden English</thinking>שלום",
    );
    expect(element(".chat-text")?.getAttribute("dir")).toBe("rtl");
    expect(elementText(".chat-text")?.trim()).toBe("שלום");
  });

  it.each([
    ["compact details", "<details><summary>More</summary>body</details>", "details"],
    ["table", "| Name | Value |\n| --- | --- |\n| one | two |", ".markdown-table"],
  ])("keeps a duplicate marker outside terminal %s content", (_label, markdownText, terminal) => {
    markdownRenderMock.mockImplementationOnce(renderMarkdownHtml);
    renderAssistantMessageEntries([
      {
        key: "assistant-duplicate",
        message: createAssistantMessage(markdownText, { timestamp: 1 }),
        duplicateCount: 3,
      },
    ]);

    const chatText = requireElement(".chat-text", HTMLDivElement);
    const terminalBlock = requireElement(terminal, HTMLElement, chatText);
    expect(terminalBlock.querySelector(".chat-duplicate-count")).toBeNull();
    expect(chatText.querySelector(":scope > .chat-duplicate-count")?.textContent).toBe("×3");
    expect(chatText.querySelector("summary")?.textContent ?? "").not.toContain("×3");
    expect(chatText.querySelector("td:last-child")?.textContent ?? "").not.toContain("×3");
  });

  function renderAssistantDisclosureActionFixture(
    options: Partial<RenderMessageGroupOptions> = {},
    message: TestMessage = {},
    text = "Assistant preview\n...(truncated)...",
  ) {
    renderAssistantMessage(
      createAssistantMessage(text, {
        __openclaw: { id: "assistant-disclosure-actions", seq: 1, truncated: true },
        ...message,
      }),
      {
        sessionKey: "agent:main:main",
        loadFullAssistantMessage: async () => null,
        getAssistantMessageExpansion: () => ({
          status: "loaded",
          markdown: "Complete assistant message beyond the transcript preview.",
          revision: 1,
        }),
        onToggleAssistantMessageExpanded: vi.fn(),
        ...options,
      },
    );
    return { container: harness.view, preview: text };
  }

  it("keeps loaded assistant thinking private while bounding reply context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const onReply = vi.fn();
    const visibleMessage = `${"a".repeat(499)}😀 full loaded answer`;
    renderAssistantDisclosureActionFixture({
      onReply,
      getAssistantMessageExpansion: () => ({
        status: "loaded",
        markdown: `<thinking>private loaded reasoning</thinking>${visibleMessage}`,
        revision: 1,
      }),
    });

    requireElement(".chat-group-footer-actions .chat-copy-btn", HTMLButtonElement).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(visibleMessage));

    requireElement(
      '.chat-group-footer-actions [aria-label="Reply to message"]',
      HTMLButtonElement,
    ).click();
    expect(onReply).toHaveBeenCalledWith({
      messageId: "assistant-message",
      senderLabel: "OpenClaw",
      sourceMessageId: "assistant-disclosure-actions",
      text: "a".repeat(499),
    });
    expect(element(".chat-bubble")?.dataset.messageText).toBe(visibleMessage);
  });

  it("does not restore a disclosure control for hidden-only loaded assistant text", () => {
    const onReply = vi.fn();
    const onToggleAssistantMessageExpanded = vi.fn();
    const privateThinking = "private expanded reasoning only";
    const { preview } = renderAssistantDisclosureActionFixture({
      onReply,
      onToggleAssistantMessageExpanded,
      getAssistantMessageExpansion: () => ({
        status: "loaded",
        markdown: `<thinking>${privateThinking}</thinking>`,
        revision: 1,
      }),
    });

    expect(elementText(".chat-text")?.trim()).toBe("");
    expect(harness.view.textContent).not.toContain(privateThinking);
    expect(harness.view.textContent).not.toContain(preview);
    expectAbsent(
      ".chat-group-footer-actions .chat-copy-btn",
      '[aria-label="Reply to message"]',
      ".chat-message-disclosure__toggle",
    );
    expect(element(".chat-bubble")?.hasAttribute("data-message-text")).toBe(false);
    expect(onToggleAssistantMessageExpanded).not.toHaveBeenCalled();
  });

  it("admits one full-message load for repeated source projections in a group", () => {
    const previews = ["First projection", "Updated projection"];
    let loading = false;
    const onToggleAssistantMessageExpanded = vi.fn(() => {
      loading = true;
    });
    renderAssistantMessages(
      previews.map((text) =>
        createAssistantMessage(text, {
          __openclaw: { id: "shared-source", truncated: true },
        }),
      ),
      {
        sessionKey: "global",
        loadFullAssistantMessage: async () => null,
        getAssistantMessageExpansion: () =>
          loading ? { status: "loading", revision: 1 } : undefined,
        onToggleAssistantMessageExpanded,
      },
    );

    expect(onToggleAssistantMessageExpanded).toHaveBeenCalledTimes(1);
    expect(onToggleAssistantMessageExpanded).toHaveBeenCalledWith("shared-source");
    expect(elements(".chat-text").map((node) => node.textContent)).toEqual(previews);
  });

  it("retries a failed full-message load while attempts remain", () => {
    const onToggleAssistantMessageExpanded = vi.fn();
    renderAssistantDisclosureActionFixture({
      getAssistantMessageExpansion: () => ({ status: "error", revision: 2 }),
      onToggleAssistantMessageExpanded,
    });
    expect(onToggleAssistantMessageExpanded).toHaveBeenCalledWith("assistant-disclosure-actions");
  });

  it("does not fetch full content for mirrored message-tool replies", () => {
    const onToggleAssistantMessageExpanded = vi.fn();
    renderAssistantDisclosureActionFixture(
      {
        sessionKey: "global",
        getAssistantMessageExpansion: () => undefined,
        onToggleAssistantMessageExpanded,
      },
      { openclawMessageToolMirror: { toolName: "message", toolCallId: "call-1" } },
      "mirrored text\n...(truncated)...",
    );

    expectAbsent(".chat-message-disclosure__toggle");
    expect(onToggleAssistantMessageExpanded).not.toHaveBeenCalled();
  });

  it("keeps the oversized notice visible when assistant recovery exhausts", () => {
    const onToggleAssistantMessageExpanded = vi.fn();
    renderAssistantDisclosureActionFixture(
      {
        sessionKey: "global",
        getAssistantMessageExpansion: () => ({ status: "error", revision: 6 }),
        onToggleAssistantMessageExpanded,
      },
      { __openclaw: { id: "oversized-assistant-error", truncated: true, reason: "oversized" } },
      "[chat.history omitted: message too large]",
    );

    expect(elementText(".chat-text")).toContain("This message is too large to display here.");
    expect(harness.view.textContent).not.toContain("[chat.history omitted");
    expect(elementText(".chat-message-load-error")).toContain("Could not load the full message.");
    expect(onToggleAssistantMessageExpanded).not.toHaveBeenCalled();
    requireElement(".chat-message-load-error__retry", HTMLButtonElement).click();
    expect(onToggleAssistantMessageExpanded).toHaveBeenCalledWith("oversized-assistant-error");
  });
});
