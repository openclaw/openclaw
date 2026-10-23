/* @vitest-environment jsdom */
// Contract for full-message eligibility: the Gateway marks every display-
// capped projection; pending inputs share assistant expansion without gaining
// transcript mutation actions.
import { For } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import { extractText } from "../../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import * as toolCards from "../../../lib/chat/tool-cards.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import * as thinking from "../../../lib/strip-thinking-tags.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { prepareGroupedMessage } from "./chat-message-bubble-presentation.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import {
  prepareChatMessageRender,
  resolveMessageActionDetails,
} from "./chat-message-markdown-view.tsx";
import { MessageMarkdown } from "./chat-message-text-view.tsx";

const cappedMeta = { id: "msg-1", truncated: true, reason: "display-cap" };

describe("message action projections", () => {
  it("reuses prepared assistant text but sanitizes newly loaded action text", () => {
    const strip = vi.spyOn(thinking, "stripThinkingTags");
    onTestFinished(() => strip.mockRestore());
    const prepared = prepareChatMessageRender({
      role: "assistant",
      content: "<think>Private reasoning</think>Visible reply",
      __openclaw: cappedMeta,
    });
    strip.mockClear();
    const options = {
      messageId: "msg-1",
      canFetchFullMessage: true,
      onReply: () => {},
      senderLabel: "Assistant",
    };
    const details = resolveMessageActionDetails(prepared, options);
    expect(strip).not.toHaveBeenCalled();
    expect(details).toMatchObject({
      markdown: "Visible reply",
      copyMarkdown: "Visible reply",
      readAloudText: "Visible reply",
      replyTarget: { text: "Visible reply" },
    });
    const loaded = resolveMessageActionDetails(prepared, {
      ...options,
      getAssistantMessageExpansion: () => ({
        status: "loaded",
        markdown: "<think>Private expansion</think>Expanded reply",
        revision: 1,
      }),
    });
    expect(strip).toHaveBeenCalledOnce();
    expect(loaded).toMatchObject({
      markdown: "Expanded reply",
      copyMarkdown: "Expanded reply",
      readAloudText: "Expanded reply",
      replyTarget: { text: "Expanded reply" },
    });
  });

  it("defers collapsed previews until a tool message shell renders", async () => {
    const preview = vi.spyOn(toolCards, "formatCollapsedToolPreviewText");
    onTestFinished(() => preview.mockRestore());
    const prepare = (role: string, content: string) =>
      prepareGroupedMessage(prepareChatMessageRender({ role, content }), "message", {
        isStreaming: true,
        showReasoning: false,
      });
    prepare("assistant", "A streaming reply");
    expect(preview).not.toHaveBeenCalled();
    prepare("toolResult", "First line\nSecond line");
    expect(preview).not.toHaveBeenCalled();
    const container = document.createElement("div");
    const view = mountSolid(
      GroupedMessage,
      {
        preparation: prepareChatMessageRender({
          role: "toolResult",
          content: "First line\nSecond line",
        }),
        messageKey: "tool-preview",
        options: { isStreaming: true, showReasoning: false },
      },
      container,
    );
    onTestFinished(view.dispose);
    await waitForSolid(() =>
      expect(container.querySelector(".chat-tool-msg-summary__names")?.textContent).toBe("tool"),
    );
    expect(preview).toHaveBeenCalledWith("First line\nSecond line");
  });

  const indented = "    *literal*";
  const oversized = "This message is too large to display here.";
  it.each<
    [
      name: string,
      role: string,
      content: unknown,
      metadata: { id: string; truncated?: boolean; reason?: string },
      expected?: {
        fullId?: string;
        markdown?: string;
        reply?: string;
        expanded?: string;
        onReply?: boolean;
      },
    ]
  >([
    [
      "capped assistant indentation",
      "assistant",
      indented,
      cappedMeta,
      { fullId: "msg-1", markdown: indented, expanded: indented },
    ],
    ["capped user", "user", "Preview\n...(truncated)...", cappedMeta, { onReply: true }],
    [
      "accepted input",
      "user",
      "Preview\n...(truncated)...",
      { ...cappedMeta, id: "pending:input-1" },
      { fullId: "pending:input-1", expanded: "<think>literal user input</think>", onReply: true },
    ],
    [
      "literal sentinel",
      "assistant",
      "Quoting a log line:\n...(truncated)...\nand continuing normally.",
      { id: "msg-3" },
    ],
    [
      "oversized recovery",
      "assistant",
      "[chat.history omitted: message too large]",
      { id: "msg-oversized", truncated: true, reason: "oversized" },
      {
        fullId: "msg-oversized",
        markdown: oversized,
        reply: oversized,
        expanded: "Recovered full assistant content.",
        onReply: true,
      },
    ],
    [
      "omitted image reply",
      "assistant",
      [{ type: "image", omitted: true, bytes: 12 * 1024 }],
      { id: "msg-omitted-image" },
      { reply: "Image · Omitted from history · 12 KB", onReply: true },
    ],
  ])(
    "preserves recovery, copy and reply semantics for %s",
    (_name, role, content, metadata, expected = {}) => {
      const entry = { role, content, metadata, ...expected };
      const message = { role: entry.role, content: entry.content, __openclaw: entry.metadata };
      const prepared = prepareChatMessageRender(message);
      const options = {
        messageId: entry.metadata.id,
        canFetchFullMessage: true,
        onReply: entry.onReply ? () => {} : undefined,
        senderLabel: entry.role,
      };
      const details = resolveMessageActionDetails(prepared, options);
      expect(details?.fullMessage?.messageId).toBe(entry.fullId);
      if (!entry.fullId) {
        expect(details?.fullMessage).toBeUndefined();
      }
      if (entry.markdown !== undefined) {
        expect(details?.markdown).toBe(entry.markdown);
      }
      if (entry.reply !== undefined) {
        expect(details?.replyTarget?.text).toBe(entry.reply);
      }
      if (entry.content === indented) {
        expect(extractText(message)).toBe(indented);
      }
      if (entry.expanded !== undefined) {
        const markdown = entry.expanded;
        const loaded = resolveMessageActionDetails(prepared, {
          ...options,
          getAssistantMessageExpansion: () => ({ status: "loaded", markdown, revision: 1 }),
        });
        expect(loaded?.fullMessage?.messageId).toBe(entry.fullId);
        expect(loaded?.markdown).toBe(markdown);
        if (entry.role === "user") {
          expect(loaded?.replyTarget).toBeUndefined();
          expect(persistedMessageEntryId(message)).toBeNull();
        } else if (entry.onReply) {
          expect(loaded?.replyTarget?.text).toBe(markdown);
        }
      }
    },
  );
});

describe("user message disclosure", () => {
  it("batches and retains overflow measurements while observing content, fonts and lifetime", async () => {
    const fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
    const previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    const pendingObservers = new Set<() => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly notify: () => void) {}
        observe() {
          pendingObservers.add(this.notify);
        }
        disconnect() {
          pendingObservers.delete(this.notify);
        }
      },
    );
    const container = document.body.appendChild(document.createElement("div"));
    const restoreStyles: Array<() => void> = [];
    const markdown = "A long prompt with unchanged layout. ".repeat(50);
    const view = mountSolid(
      (props: { text: string; expanded: boolean; presented: boolean }) => (
        <ContentPresentation value={() => props.presented}>
          <For each={["first", "second"]}>
            {(key) => (
              <MessageMarkdown
                markdown={props.text}
                messageKey={key}
                options={{
                  role: "user",
                  isStreaming: false,
                  isUserMessageExpanded: () => props.expanded,
                  onToggleUserMessageExpanded: vi.fn(),
                }}
                markdownOptions={{}}
              />
            )}
          </For>
        </ContentPresentation>
      ),
      { text: markdown, expanded: false, presented: true },
      container,
    );
    let current = { text: markdown, expanded: false, presented: true };
    const draw = (text = markdown, expanded = false) => {
      current = { ...current, text, expanded };
      view.update(current);
    };
    const present = (presented: boolean) => {
      current = { ...current, presented };
      view.update(current);
    };
    const settle = async () => {
      for (const notify of pendingObservers) {
        notify();
      }
      pendingObservers.clear();
      await Promise.resolve();
      await Promise.resolve();
    };
    try {
      draw();
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
      present(false);
      measure.mockClear();
      await settle();
      fonts.dispatchEvent(new Event("loadingdone"));
      await settle();
      expect(measure).not.toHaveBeenCalled();
      present(true);
      await settle();
      expect(measure).toHaveBeenCalled();
    } finally {
      view.dispose();
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

    mountSolid(
      MessageMarkdown,
      {
        markdown,
        messageKey: "message",
        options: { role: "user", isStreaming: false, onToggleUserMessageExpanded: vi.fn() },
        markdownOptions: {},
      },
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
    { markdown: "Intro\n\nTail", owner: ".chat-text > p:last-child" },
    { markdown: "Intro\n\n", owner: ".chat-text > p" },
    { markdown: "Intro\n\n```ts\nconst answer = 42;\n```", owner: ".chat-text" },
  ])("keeps the duplicate count on the terminal owner for $markdown", ({ markdown, owner }) => {
    const container = document.createElement("div");
    const view = mountSolid(
      MessageMarkdown,
      {
        markdown,
        messageKey: "streaming-duplicate",
        options: { role: "assistant", isStreaming: true },
        markdownOptions: {},
        duplicateSuffix: { count: 3, label: "Three identical messages" },
      },
      container,
    );

    expect(container.querySelectorAll(".chat-duplicate-count")).toHaveLength(1);
    expect(container.querySelector(`${owner} > .chat-duplicate-count`)?.textContent).toBe("×3");
    expect(container.querySelector("code .chat-duplicate-count")).toBeNull();

    view.update({
      markdown: `${markdown}\n\nMore`,
      messageKey: "streaming-duplicate",
      options: { role: "assistant", isStreaming: true },
      markdownOptions: {},
      duplicateSuffix: { count: 4, label: "Four identical messages" },
    });
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
        mountSolid(
          MessageMarkdown,
          { markdown, messageKey: "indent", options: { role, isStreaming }, markdownOptions: {} },
          container,
        );
        expect(container.querySelector("pre code")?.textContent).toBe("*literal*\n");
        expect(container.querySelector("em")).toBeNull();
      }
    }
  });
});

describe("persisted human mentions in message bubbles", () => {
  const text = "@Ada Lovelace cc @Ada Lovelace";
  const humanMentions = [{ profileId: "profile-ada", start: 0, end: 13 }];

  it.each<
    [
      name: string,
      role: string,
      content: unknown,
      metadata:
        | { humanMentions: typeof humanMentions; truncated?: boolean; reason?: string }
        | undefined,
      selected: boolean,
      replacement?: string,
    ]
  >([
    ["string content", "user", text, { humanMentions }, true],
    ["text block", "user", [{ type: "text", text }], { humanMentions }, true],
    ["assistant", "assistant", text, { humanMentions }, false],
    ["capped user", "user", text, { humanMentions, truncated: true, reason: "oversized" }, false],
    ["unselected text", "user", text, undefined, false],
    ["replaced display", "user", text, { humanMentions }, false, "@Different Person"],
  ])(
    "attaches identities only to unchanged selected user spans: %s",
    (_name, role, content, metadata, selected, replacement) => {
      const entry = { role, content, metadata, selected, replacement };
      const host = document.createElement("div");
      mountSolid(
        GroupedMessage,
        {
          preparation: prepareChatMessageRender({
            role: entry.role,
            content: entry.content,
            __openclaw: entry.metadata,
          }),
          messageKey: "message",
          options: {
            isStreaming: false,
            showReasoning: false,
            messageActions: entry.replacement ? { markdown: entry.replacement } : undefined,
          },
        },
        host,
      );
      const references = host.querySelectorAll("openclaw-person-reference");
      expect(references).toHaveLength(entry.selected ? 1 : 0);
      if (entry.selected) {
        expect(references[0]?.getAttribute("profile-id")).toBe("profile-ada");
        expect(references[0]?.getAttribute("label")).toBe("@Ada Lovelace");
        expect(host.querySelector(".chat-bubble")?.getAttribute("data-message-text")).toBe(text);
      }
      if (entry.replacement) {
        expect(host.textContent).toContain(entry.replacement);
      }
    },
  );
});

it.each(["annotation only", "additional prompt", "additional file"])(
  "shows inline annotation content only for an annotation-only message: %s",
  async (scenario) => {
    const quote = "<strong>Selected text</strong>\nSecond selected line.";
    const payload = `Selected text:\n${quote}\n\nUser comment:\nKeep the full context.\n\nSource session: agent:main:fixture\nSelected text UTF-16 length: ${quote.length}\nDOM text UTF-16 range: [0, ${quote.length})`;
    const content: unknown[] = [
      {
        type: "attachment",
        attachment: {
          kind: "document",
          label: "selection-comment.txt",
          mimeType: "text/plain",
          url: `data:text/plain;base64,${btoa(payload)}`,
        },
      },
    ];
    if (scenario === "additional prompt") {
      content.push({ type: "text", text: "Please explain this." });
    }
    if (scenario === "additional file") {
      content.push({
        type: "attachment",
        attachment: {
          kind: "document",
          label: "notes.txt",
          mimeType: "text/plain",
          url: `data:text/plain;base64,${btoa("File contents")}`,
        },
      });
    }
    const host = document.createElement("div");
    mountSolid(
      GroupedMessage,
      {
        preparation: prepareChatMessageRender({ role: "user", content }),
        messageKey: "annotation-message",
        options: { isStreaming: false, showReasoning: false },
      },
      host,
    );
    if (scenario === "annotation only") {
      await waitForSolid(() =>
        expect(host.querySelector("blockquote button")?.textContent).toBe(quote),
      );
      expect(host.querySelector('blockquote [slot="content"]')?.textContent).toBe(quote);
      expect(host.textContent).toContain("Keep the full context.");
      expect(host.querySelector("blockquote strong")).toBeNull();
      expect(host.querySelector(".chat-bubble--with-images")).toBeNull();
    } else {
      expect(host.querySelector(".chat-selection-annotations__chip")).not.toBeNull();
      expect(host.querySelector("blockquote")).toBeNull();
      expect(host.textContent).not.toContain("Keep the full context.");
    }
  },
);
