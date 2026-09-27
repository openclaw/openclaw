/* @vitest-environment jsdom */
// Contract for full-message eligibility: the Gateway marks every display-
// capped projection; pending inputs share assistant expansion without gaining
// transcript mutation actions.
import { html, nothing, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { markdownBlocks } from "../../../components/markdown-blocks.ts";
import { handleMarkdownCodeBlockClick } from "../../../components/markdown-code-blocks.ts";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import { extractText } from "../../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender, resolveMessageActionDetails } from "./chat-message-markdown.ts";
import { renderMessageMarkdown } from "./chat-message-text.ts";

const cappedMeta = { id: "msg-1", truncated: true, reason: "display-cap" };

describe("resolveMessageActionDetails full-message eligibility", () => {
  it.each([
    { role: "assistant", id: "msg-1", shouldFetch: true },
    { role: "user", id: "msg-1", shouldFetch: false },
    { role: "user", id: "pending:input-1", shouldFetch: true },
  ])("role=$role capped by metadata -> eligible=$shouldFetch", ({ role, id, shouldFetch }) => {
    const details = resolveMessageActionDetails(
      prepareChatMessageRender({
        role,
        content: "Preview\n...(truncated)...",
        __openclaw: { ...cappedMeta, id },
      }),
      {
        messageId: "msg-1",
        canFetchFullMessage: true,
        onReply: () => {},
        senderLabel: role,
      },
    );
    expect(details?.fullMessage?.messageId).toBe(shouldFetch ? id : undefined);
  });

  it("expands accepted user text without granting transcript reply or rewind identity", () => {
    const message = {
      role: "user",
      content: "Preview",
      __openclaw: { ...cappedMeta, id: "pending:input-1" },
    };
    const details = resolveMessageActionDetails(prepareChatMessageRender(message), {
      messageId: "pending-render",
      canFetchFullMessage: true,
      getAssistantMessageExpansion: () => ({
        status: "loaded",
        markdown: "<think>literal user input</think>",
        revision: 1,
      }),
      onReply: vi.fn(),
      senderLabel: "user",
    });
    expect(details?.markdown).toBe("<think>literal user input</think>");
    expect(details?.replyTarget).toBeUndefined();
    expect(persistedMessageEntryId(message)).toBeNull();
  });

  it("does not fetch an assistant message that merely contains the sentinel text", () => {
    // The in-band "...(truncated)..." is ordinary Markdown to the UI; without the
    // Gateway's structural marker it is not evidence of a display cap.
    const details = resolveMessageActionDetails(
      prepareChatMessageRender({
        role: "assistant",
        content: "Quoting a log line:\n...(truncated)...\nand continuing normally.",
        __openclaw: { id: "msg-3" },
      }),
      {
        messageId: "msg-3",
        canFetchFullMessage: true,
        senderLabel: "assistant",
      },
    );
    expect(details?.fullMessage).toBeUndefined();
  });

  it("projects an oversized assistant marker to a notice without disabling recovery", () => {
    const message = {
      role: "assistant",
      content: "[chat.history omitted: message too large]",
      __openclaw: { id: "msg-oversized", truncated: true, reason: "oversized" },
    };
    const details = resolveMessageActionDetails(prepareChatMessageRender(message), {
      messageId: "msg-oversized",
      canFetchFullMessage: true,
      onReply: () => {},
      senderLabel: "assistant",
    });

    expect(details?.fullMessage?.messageId).toBe("msg-oversized");
    expect(details?.markdown).toBe("This message is too large to display here.");
    expect(details?.replyTarget?.text).toBe("This message is too large to display here.");

    const loaded = resolveMessageActionDetails(prepareChatMessageRender(message), {
      messageId: "msg-oversized",
      canFetchFullMessage: true,
      getAssistantMessageExpansion: () => ({
        status: "loaded",
        markdown: "Recovered full assistant content.",
        revision: 1,
      }),
      onReply: () => {},
      senderLabel: "assistant",
    });

    expect(loaded?.fullMessage?.messageId).toBe("msg-oversized");
    expect(loaded?.markdown).toBe("Recovered full assistant content.");
    expect(loaded?.replyTarget?.text).toBe("Recovered full assistant content.");
  });

  it("projects an omitted historical image into reply text", () => {
    const details = resolveMessageActionDetails(
      prepareChatMessageRender({
        role: "assistant",
        content: [{ type: "image", omitted: true, bytes: 12 * 1024 }],
        __openclaw: { id: "msg-omitted-image" },
      }),
      {
        messageId: "msg-omitted-image",
        onReply: () => {},
        senderLabel: "assistant",
      },
    );

    expect(details?.replyTarget?.text).toBe("Image · Omitted from history · 12 KB");
  });
});

describe("user message disclosure", () => {
  it("batches and retains overflow measurements while observing content, fonts and lifetime", async () => {
    const fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
    const previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const container = document.body.appendChild(document.createElement("div"));
    const restoreStyles: Array<() => void> = [];
    const markdown = "A long prompt with unchanged layout. ".repeat(50);
    const draw = (text = markdown, expanded = false) =>
      render(
        html`${["first", "second"].map((key) =>
          renderMessageMarkdown(
            text,
            key,
            {
              role: "user",
              isStreaming: false,
              isUserMessageExpanded: () => expanded,
              onToggleUserMessageExpanded: vi.fn(),
            },
            {},
          ),
        )}`,
        container,
      );
    const settle = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };
    try {
      const part = draw();
      const phases: string[] = [];
      const measure = vi.fn(() => {
        phases.push("read");
        return 300;
      });
      for (const content of container.querySelectorAll<HTMLElement>(
        ".chat-message-disclosure__content",
      )) {
        Object.defineProperties(content, {
          scrollHeight: { get: measure },
          clientHeight: { get: () => 100 },
        });
        const remove = content.style.removeProperty.bind(content.style);
        const removal = vi.spyOn(content.style, "removeProperty").mockImplementation((property) => {
          phases.push("write");
          return remove(property);
        });
        restoreStyles.push(() => removal.mockRestore());
      }
      await settle();
      expect(measure).toHaveBeenCalled();
      expect(phases.slice(phases.indexOf("read"), phases.lastIndexOf("read") + 1)).not.toContain(
        "write",
      );
      measure.mockClear();
      for (let index = 0; index < 5; index += 1) {
        draw();
        await settle();
      }
      expect(measure).not.toHaveBeenCalled();

      draw(`${markdown}Updated content.`);
      await settle();
      expect(measure).toHaveBeenCalled();
      measure.mockClear();
      draw(`${markdown}Updated content.`, true);
      await settle();
      expect(measure).toHaveBeenCalled();
      expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
      measure.mockClear();
      fonts.dispatchEvent(new Event("loadingdone"));
      await settle();
      expect(measure).toHaveBeenCalled();

      draw(`${markdown}Retired before measurement.`);
      part.setConnected(false);
      measure.mockClear();
      await settle();
      fonts.dispatchEvent(new Event("loadingdone"));
      await settle();
      expect(measure).not.toHaveBeenCalled();
      part.setConnected(true);
      await settle();
      expect(measure).toHaveBeenCalled();
    } finally {
      render(nothing, container);
      container.remove();
      restoreStyles.forEach((restore) => restore());
      vi.unstubAllGlobals();
      if (previousFonts) {
        Object.defineProperty(document, "fonts", previousFonts);
      } else {
        Reflect.deleteProperty(document, "fonts");
      }
    }
  });

  it.each([
    { name: "exactly 1200 UTF-16 code units", markdown: "a".repeat(1_200) },
    { name: "forty short lines", markdown: Array(40).fill("a").join("\n") },
  ])("keeps $name fully visible", ({ markdown }) => {
    const container = document.createElement("div");

    render(
      renderMessageMarkdown(
        markdown,
        "message",
        { role: "user", isStreaming: false, onToggleUserMessageExpanded: vi.fn() },
        {},
      ),
      container,
    );

    expect(container.querySelector(".chat-message-disclosure")).toBeNull();
    for (const line of markdown.split("\n").filter(Boolean)) {
      expect(container.textContent).toContain(line);
    }
  });
});

describe("streaming message Markdown", () => {
  it.each([
    { stage: "following paragraph", tail: "The answer is ready.", isStreaming: true },
    {
      stage: "later paragraph",
      tail: "The answer is ready.\n\nMore is arriving.",
      isStreaming: true,
    },
    {
      stage: "completed reply with its message owner retained",
      tail: "The answer is ready.",
      isStreaming: false,
    },
  ])("retains completed code choices in the $stage", async ({ tail, isStreaming }) => {
    const container = document.body.appendChild(document.createElement("div"));
    const code = Array.from({ length: 10 }, (_, index) => `const value${index} = ${index};`).join(
      "\n",
    );
    const prefix = `\`\`\`ts\n${code}\n\`\`\`\n\n`;
    const renderTail = (text: string, streaming: boolean) =>
      render(
        html`<section ${markdownBlocks()} @click=${handleMarkdownCodeBlockClick}>
          ${renderMessageMarkdown(
            prefix + text,
            "retained-fence",
            { role: "assistant", isStreaming: streaming },
            { codeBlockInteraction: "interactive", linkFavicons: !streaming },
          )}
        </section>`,
        container,
      );
    try {
      renderTail("The answer", true);
      await Promise.resolve();
      container.querySelector<HTMLButtonElement>(".code-block-expand")?.click();
      container.querySelector<HTMLButtonElement>(".code-block-wrap")?.click();
      expect(container.querySelector(".code-block-expand")?.getAttribute("aria-expanded")).toBe(
        "true",
      );
      expect(container.querySelector(".code-block-wrap")?.getAttribute("aria-pressed")).toBe(
        "true",
      );

      renderTail(tail, isStreaming);
      await Promise.resolve();

      expect(container.querySelector(".code-block-expand")?.getAttribute("aria-expanded")).toBe(
        "true",
      );
      expect(container.querySelector(".code-block-wrap")?.getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(container.querySelector(".code-block-wrapper.is-expanded.is-wrapped")).not.toBeNull();
      expect(container.querySelector(".chat-text > p:last-child")?.textContent).toBe(
        tail.split("\n\n").at(-1),
      );
    } finally {
      render(nothing, container);
      container.remove();
    }
  });

  it.each([
    "message identity",
    "source correction",
    "render options",
    "reference definition",
  ] as const)("updates streaming Markdown after a %s change", async (change) => {
    const container = document.body.appendChild(document.createElement("div"));
    const source = "```ts\nconst original = 42;\n```\n\nSee [guide][ref]\n\nTail";
    const show = (markdown: string, key = "message", interactive = true) =>
      render(
        html`<section ${markdownBlocks()} @click=${handleMarkdownCodeBlockClick}>
          ${renderMessageMarkdown(
            markdown,
            key,
            { role: "assistant", isStreaming: true },
            { codeBlockInteraction: interactive ? "interactive" : "static" },
          )}
        </section>`,
        container,
      );
    try {
      show(source);
      await Promise.resolve();
      container.querySelector<HTMLButtonElement>(".code-block-wrap")?.click();
      expect(container.querySelector(".code-block-wrap")?.getAttribute("aria-pressed")).toBe(
        "true",
      );

      if (change === "message identity") {
        show(source, "other-message");
        expect(container.querySelector(".code-block-wrap")?.getAttribute("aria-pressed")).toBe(
          "false",
        );
      } else if (change === "source correction") {
        show(source.replace("const original = 42;", "const corrected = 43;"));
        expect(container.querySelector("code")?.textContent).toBe("const corrected = 43;\n");
      } else if (change === "render options") {
        show(source, "message", false);
        expect(container.querySelector(".code-block-wrap")).toBeNull();
        expect(container.querySelector(".code-block-copy")).not.toBeNull();
      } else {
        show(`${source}\n\n[ref]: https://example.com/guide`);
        expect(container.querySelector('a[href="https://example.com/guide"]')?.textContent).toBe(
          "guide",
        );
      }
      expect(container.querySelectorAll("pre code")).toHaveLength(1);
    } finally {
      render(nothing, container);
      container.remove();
    }
  });

  it.each([
    { markdown: "Intro\n\nTail", owner: ".chat-text > p:last-child" },
    { markdown: "Intro\n\n", owner: ".chat-text > p" },
    { markdown: "Intro\n\n```ts\nconst answer = 42;\n```", owner: ".chat-text" },
  ])("keeps the duplicate count on the terminal owner for $markdown", ({ markdown, owner }) => {
    const container = document.createElement("div");
    render(
      renderMessageMarkdown(
        markdown,
        "streaming-duplicate",
        { role: "assistant", isStreaming: true },
        {},
        { count: 3, label: "Three identical messages" },
      ),
      container,
    );

    expect(container.querySelectorAll(".chat-duplicate-count")).toHaveLength(1);
    expect(container.querySelector(`${owner} > .chat-duplicate-count`)?.textContent).toBe("×3");
    expect(container.querySelector("code .chat-duplicate-count")).toBeNull();

    render(
      renderMessageMarkdown(
        `${markdown}\n\nMore`,
        "streaming-duplicate",
        { role: "assistant", isStreaming: true },
        {},
        { count: 4, label: "Four identical messages" },
      ),
      container,
    );
    expect(container.querySelectorAll(".chat-duplicate-count")).toHaveLength(1);
    expect(
      container.querySelector(".chat-text > p:last-child > .chat-duplicate-count")?.textContent,
    ).toBe("×4");
    expect(container.querySelector("code .chat-duplicate-count")).toBeNull();
  });
});

describe("message Markdown source preservation", () => {
  it.each(["user", "assistant"])("preserves initial code for %s messages", (role) => {
    for (const source of ["    *literal*", "\t*literal*", "\n\n    *literal*"]) {
      const message = { role, content: [{ type: "text", text: source }] };
      const markdown = resolveMessageDisplayMarkdown(message, normalizeMessage(message));
      for (const isStreaming of [false, true]) {
        const container = document.createElement("div");
        render(renderMessageMarkdown(markdown, "indent", { role, isStreaming }, {}), container);
        expect(container.querySelector("pre code")?.textContent).toBe("*literal*\n");
        expect(container.querySelector("em")).toBeNull();
      }
    }
  });

  it("preserves assistant snapshot indentation and recovered Markdown for copying", () => {
    const source = "    *literal*";
    const message = { role: "assistant", content: source, __openclaw: cappedMeta };
    expect(extractText(message)).toBe(source);
    const details = resolveMessageActionDetails(prepareChatMessageRender(message), {
      messageId: "msg-1",
      canFetchFullMessage: true,
      getAssistantMessageExpansion: () => ({ status: "loaded", markdown: source, revision: 1 }),
      senderLabel: "assistant",
    });
    expect(details?.markdown).toBe(source);
  });
});

describe("persisted human mentions in message bubbles", () => {
  const text = "@Ada Lovelace cc @Ada Lovelace";
  const humanMentions = [{ profileId: "profile-ada", start: 0, end: 13 }];

  it.each([{ content: text }, { content: [{ type: "text", text }] }])(
    "renders only explicit spans while preserving copy text",
    ({ content }) => {
      const message = { role: "user", content, __openclaw: { humanMentions } };
      const host = document.createElement("div");
      render(
        renderGroupedMessage(prepareChatMessageRender(message), "message", {
          isStreaming: false,
          showReasoning: false,
        }),
        host,
      );
      const references = host.querySelectorAll("openclaw-person-reference");
      expect(references).toHaveLength(1);
      expect(references[0]?.getAttribute("profile-id")).toBe("profile-ada");
      expect(references[0]?.getAttribute("label")).toBe("@Ada Lovelace");
      expect(host.querySelector(".chat-bubble")?.getAttribute("data-message-text")).toBe(text);
    },
  );

  it.each([
    { role: "assistant", content: text, __openclaw: { humanMentions } },
    {
      role: "user",
      content: text,
      __openclaw: { humanMentions, truncated: true, reason: "oversized" },
    },
    { role: "user", content: text },
  ])("does not attach identities to assistant, capped or unselected text", (message) => {
    const host = document.createElement("div");
    render(
      renderGroupedMessage(prepareChatMessageRender(message), "message", {
        isStreaming: false,
        showReasoning: false,
      }),
      host,
    );
    expect(host.querySelector("openclaw-person-reference")).toBeNull();
  });

  it("does not reuse selection offsets after the displayed message is replaced", () => {
    const host = document.createElement("div");
    render(
      renderGroupedMessage(
        prepareChatMessageRender({ role: "user", content: text, __openclaw: { humanMentions } }),
        "message",
        {
          isStreaming: false,
          showReasoning: false,
          messageActions: { markdown: "@Different Person" },
        },
      ),
      host,
    );
    expect(host.querySelector("openclaw-person-reference")).toBeNull();
    expect(host.textContent).toContain("@Different Person");
  });
});
