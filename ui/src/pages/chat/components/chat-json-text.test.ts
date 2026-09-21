/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMarkdownCodeBlockCopyText } from "../../../components/markdown-code-blocks.ts";
import { TOOL_OUTPUT_PREVIEW_CHARS } from "../../../lib/chat/tool-output.ts";
import "./chat-tool-output.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import { createMessageGroup } from "./chat-message.test-support.ts";
import { renderMessageGroup } from "./chat-message.ts";
import type { SidebarContent } from "./chat-sidebar.ts";
import { renderToolCard } from "./chat-tool-cards.ts";

// Keep these as literal source text: parsing expected values would repeat the
// rounding and duplicate-key loss that the display must not introduce.
const jsonSources = [
  {
    name: "object numeric lexemes",
    text: '{"id":9007199254740993,"overflow":1e400,"decimal":0.1234567890123456789,"zero":-0}',
  },
  {
    name: "array numeric lexemes",
    text: "[9007199254740993,1e400,0.1234567890123456789,-0]",
  },
  { name: "duplicate keys", text: '{"state":"before","state":"after"}' },
  {
    name: "escaped strings",
    text: String.raw`{"quoted":"say \"hello\"","slash":"\/","unicode":"\u0061","backslash":"\\"}`,
  },
  { name: "literal Markdown", text: '{"text":"**stars**"}' },
  { name: "ordinary formatted JSON", text: '{\n  "count": 42,\n  "ready": true\n}' },
  {
    name: "natural nested indentation and string whitespace",
    text: '{\n\t"nested": {\n\t\t"id": 9007199254740993,\n\t\t"state": "before", "state": "after",\n\t\t"text": "  keep these spaces  "\n\t}\n}',
  },
];

const containers: HTMLElement[] = [];

function createContainer() {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  return container;
}

afterEach(() => {
  for (const container of containers.splice(0)) {
    render(nothing, container);
    container.remove();
  }
});

describe.each(["user", "assistant", "toolResult"])("%s JSON message text", (role) => {
  function renderMessage(text: string, isStreaming = false) {
    const container = createContainer();
    render(
      renderGroupedMessage(
        prepareChatMessageRender({
          role,
          content: text,
          ...(role === "toolResult" ? { toolName: "lookup", toolCallId: "json-result" } : {}),
        }),
        "json-message",
        { isStreaming, showReasoning: false, isToolMessageExpanded: () => true },
      ),
      container,
    );
    return container;
  }

  it.each([
    ...jsonSources,
    {
      name: "CRLF and literal Unicode separators",
      text: '{\r\n  "text": "before\u2028between\u2029after"\r\n}',
    },
  ])("preserves $name in literal code and copy", ({ text }) => {
    const container = renderMessage(text);
    expect(container.querySelector(".chat-text pre code")?.textContent).toBe(text);
    expect(container.querySelector(".chat-text strong")).toBeNull();
    const copy = container.querySelector<HTMLElement>(".code-block-copy");
    if (role === "user") {
      expect(copy).toBeNull();
      expect(container.querySelector(".code-block-wrapper")).toBeNull();
    } else {
      expect(copy).not.toBeNull();
      expect(readMarkdownCodeBlockCopyText(copy!)).toBe(text);
    }
    if (role === "assistant") {
      expect(container.querySelectorAll(".code-block-json-tree")).toHaveLength(1);
      expect(container.querySelector('[data-json-mode="tree"]')?.getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(container.querySelector('[data-json-mode="raw"]')?.getAttribute("aria-pressed")).toBe(
        "false",
      );
      expect(container.querySelector(".code-block-viewport pre code")?.textContent).toBe(text);
    } else {
      expect(
        container.querySelector(
          ".code-block-json-tree, .code-block-json-mode, .code-block-wrap, .code-block-expand",
        ),
      ).toBeNull();
    }
    if (role === "toolResult") {
      expect(container.querySelector(".chat-tool-msg-body .chat-text pre code")?.textContent).toBe(
        text,
      );
      expect(container.querySelector(".chat-tool-msg-body details")).toBeNull();
    }
  });

  it.each([19_999, 20_000, 20_001])(
    "retains the auto-JSON rendering boundary at %i characters",
    (size) => {
      const text = '{"text":"' + "x".repeat(size - 11) + '"}';
      expect(text).toHaveLength(size);
      const container = renderMessage(text);
      if (size <= 20_000) {
        expect(container.querySelector(".chat-text pre code")?.textContent).toBe(text);
        expect(container.querySelectorAll(".code-block-json-tree")).toHaveLength(
          role === "assistant" ? 1 : 0,
        );
      } else {
        expect(container.querySelector(".code-block-json-tree")).toBeNull();
        expect(container.querySelector(".chat-text pre code")?.textContent).toBe(text);
      }
    },
  );

  it("keeps explicitly fenced JSON literal in one shared code block", () => {
    const text = '{"id":9007199254740993,"text":"**stars**"}';
    const fenced = "```json\n" + text + "\n```";
    const container = renderMessage(fenced);
    expect(container.querySelectorAll("pre code")).toHaveLength(1);
    expect(container.querySelectorAll(".code-block-json-tree")).toHaveLength(
      role === "assistant" ? 1 : 0,
    );
    // Tool cards show raw output; authored message Markdown consumes its fence.
    expect(container.querySelector("pre code")?.textContent).toBe(
      role === "toolResult" ? fenced : text + "\n",
    );
    expect(container.querySelector("pre strong")).toBeNull();
  });

  if (role === "assistant") {
    it("keeps duplicate member order and original lexemes in the message tree", () => {
      const text = String.raw`{"2":1.00,"1":1E+03,"state":9007199254740993,"state":1e400,"nested":{"zero":-0,"escaped":"\u0061"}}`;
      const container = renderMessage(text);
      const tree = container.querySelector(".code-block-json-tree")!;
      expect(
        Array.from(tree.querySelectorAll(".code-block-json-key"), (key) => key.textContent),
      ).toEqual(['"2"', '"1"', '"state"', '"state"', '"nested"', '"zero"', '"escaped"']);
      expect(
        Array.from(
          tree.querySelectorAll(".code-block-json-value--literal"),
          (value) => value.textContent,
        ),
      ).toEqual(["1.00", "1E+03", "9007199254740993", "1e400", "-0"]);
      expect(tree.querySelector(".code-block-json-value--string")?.textContent).toBe('"\\u0061"');
    });

    it("does not turn an unfenced streaming JSON message into a tree", () => {
      const text = "[9007199254740993,1e400,-0]";
      const container = renderMessage(text, true);
      expect(container.querySelector(".code-block-json-tree, .code-block-json-mode")).toBeNull();
      expect(container.textContent).toContain(text);
    });
  }

  it("keeps invalid JSON as ordinary message output", () => {
    const text = '{"count": }';
    const container = renderMessage(text);
    expect(container.querySelector(".code-block-json-tree, .code-block-json-mode")).toBeNull();
    expect(container.textContent).toContain(text);
  });
});

describe("tool JSON details", () => {
  async function openToolDetails(text: string) {
    const container = createContainer();
    const openSidebar = vi.fn<(content: SidebarContent) => void>();
    render(
      renderToolCard(
        { id: "json-tool", name: "lookup", outputText: text, completed: true },
        {
          messageKey: "test-message",
          expanded: true,
          onToggleExpanded: vi.fn(),
          onOpenSidebar: openSidebar,
        },
      ),
      container,
    );
    expect(container.querySelector(".chat-tool-card__block code")?.textContent).toBe(
      text.slice(0, TOOL_OUTPUT_PREVIEW_CHARS),
    );
    container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn")!.click();
    expect(openSidebar).toHaveBeenCalledOnce();
    const content = openSidebar.mock.calls[0]?.[0];
    expect(content?.kind).toBe("tool-output");
    if (content?.kind !== "tool-output") {
      throw new Error("Expected raw tool output inspector");
    }
    expect(content.card.outputText).toBe(text);
    const panel = createContainer();
    render(
      html`<openclaw-chat-tool-output .content=${content}></openclaw-chat-tool-output>`,
      panel,
    );
    await vi.waitFor(() =>
      expect(panel.querySelector(".chat-tool-output__text code")?.textContent).toBe(text),
    );
    return panel;
  }

  it.each(jsonSources)("preserves $name after opening tool details", async ({ text }) => {
    const panel = await openToolDetails(text);
    expect(panel.querySelector("pre code")?.textContent).toBe(text);
    expect(panel.querySelector("pre strong")).toBeNull();
  });

  it.each([19_999, 20_000, 20_001])(
    "keeps %i-character JSON output literal in details",
    async (size) => {
      const text = '{"text":"**stars**' + "x".repeat(size - 20) + '"}';
      expect(text).toHaveLength(size);
      const panel = await openToolDetails(text);
      expect(panel.querySelector("pre code")?.textContent).toBe(text);
      expect(panel.querySelector("pre strong")).toBeNull();
    },
  );

  it("keeps explicitly fenced JSON output literal in details", async () => {
    const text = '{"id":9007199254740993,"text":"**stars**"}';
    const fenced = "```json\n" + text + "\n```";
    const panel = await openToolDetails(fenced);
    expect(panel.querySelector("pre code")?.textContent).toBe(fenced);
    expect(panel.querySelector("pre strong")).toBeNull();
  });

  it("keeps invalid JSON literal in the inspector", async () => {
    const text = '{"count": }';
    const panel = await openToolDetails(text);
    expect(panel.querySelector("pre code")?.textContent).toBe(text);
  });
});

function expectElement<T extends Element>(
  container: Element,
  selector: string,
  constructor: new () => T,
): T {
  const element = container.querySelector<T>(selector);
  expect(element).toBeInstanceOf(constructor);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected ${selector} to match ${constructor.name}`);
  }
  return element;
}

function renderJsonMessageGroup(
  container: HTMLElement,
  message: unknown,
  role: string,
  opts: Partial<Parameters<typeof renderMessageGroup>[1]>,
) {
  const group = createMessageGroup(message, role, {
    key: role + "-group",
    messages: [{ key: role + "-message", message }],
  });
  render(
    renderMessageGroup(group, {
      showReasoning: true,
      showToolCalls: true,
      assistantName: "OpenClaw",
      assistantAvatar: null,
      ...opts,
    }),
    container,
  );
}

describe("JSON group DOM retention", () => {
  it.each([
    {
      name: "character-heavy",
      text: '{"id":9007199254740993,"prompt":"' + "x".repeat(1_300) + '"}',
    },
    {
      name: "newline-heavy",
      text: "[\n" + Array.from({ length: 45 }, () => "0").join(",\n") + "\n]",
    },
  ])("uses message disclosure for $name user JSON without JSON controls", ({ text }) => {
    const container = createContainer();
    const message = { role: "user", content: text, timestamp: 1 };
    const onToggleUserMessageExpanded = vi.fn();
    let expanded = false;
    const rerender = () =>
      renderJsonMessageGroup(container, message, "user", {
        isUserMessageExpanded: () => expanded,
        onToggleUserMessageExpanded,
      });
    rerender();
    const disclosure = expectElement(container, ".chat-message-disclosure", HTMLElement);
    const toggle = expectElement(disclosure, ".chat-message-disclosure__toggle", HTMLButtonElement);
    const code = expectElement(disclosure, ".chat-text pre code", HTMLElement);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(code.textContent).toBe(text);
    expect(
      container.querySelector(
        ".code-block-json-tree, .code-block-json-mode, .code-block-copy, .code-block-wrap, .code-block-expand",
      ),
    ).toBeNull();
    toggle.click();
    expect(onToggleUserMessageExpanded).toHaveBeenCalledWith("user-message:user-message");
    expanded = true;
    rerender();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(disclosure.classList.contains("is-expanded")).toBe(true);
    expect(disclosure.querySelector("pre code")).toBe(code);
    expanded = false;
    rerender();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(code.textContent).toBe(text);
  });
  it("preserves the user JSON code DOM across rerenders without controls", () => {
    const container = createContainer();
    const message = { role: "user", content: '{"ok":true}', timestamp: 1 };
    renderJsonMessageGroup(container, message, "user", { autoExpandToolCalls: true });
    const code = expectElement(container, ".chat-text pre code", HTMLElement);
    expect(code.textContent).toBe(message.content);
    expect(container.querySelector(".chat-text button, .chat-text details")).toBeNull();

    renderJsonMessageGroup(container, message, "user", { autoExpandToolCalls: false });

    expect(container.querySelector(".chat-text pre code")).toBe(code);
    expect(container.querySelector(".code-block-wrapper")).toBeNull();
  });

  it("preserves native assistant JSON tree disclosure state across rerenders", () => {
    const container = createContainer();
    const message = { role: "assistant", content: '{"nested":{"ok":true}}', timestamp: 1 };
    renderJsonMessageGroup(container, message, "assistant", { autoExpandToolCalls: true });
    const tree = expectElement(container, ".code-block-json-tree", HTMLElement);
    const root = expectElement(tree, ":scope > details", HTMLDetailsElement);
    const nested = expectElement(root, ".code-block-json-children details", HTMLDetailsElement);
    const code = expectElement(container, ".code-block-viewport pre code", HTMLElement);
    expect(root.open).toBe(true);
    expect(nested.open).toBe(true);
    expectElement(nested, ":scope > summary", HTMLElement).click();
    expect(nested.open).toBe(false);

    renderJsonMessageGroup(container, message, "assistant", { autoExpandToolCalls: false });

    expect(container.querySelector(".code-block-json-tree")).toBe(tree);
    expect(tree.querySelector(":scope > details")).toBe(root);
    expect(root.querySelector(".code-block-json-children details")).toBe(nested);
    expect(nested.open).toBe(false);
    expect(container.querySelector(".code-block-viewport pre code")).toBe(code);
    expect(code.textContent).toBe(message.content);
  });
});
