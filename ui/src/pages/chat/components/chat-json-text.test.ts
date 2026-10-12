/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMarkdownCodeBlockCopyText } from "../../../components/markdown-code-blocks.ts";
import { TOOL_OUTPUT_PREVIEW_CHARS } from "../../../lib/chat/tool-output.ts";
import "./chat-tool-output.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import { createMessageGroup } from "./chat-message.test-support.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { renderToolCard } from "./chat-tool-cards.ts";
import { renderToolFixture } from "./chat-tool-render.test-support.ts";

// Keep these as literal source text: parsing expected values would repeat the
// rounding and duplicate-key loss that the display must not introduce.
const jsonSources = [
  {
    name: "object lexemes, duplicate keys, escapes and whitespace",
    text: '{\r\n\t"id":9007199254740993,"overflow":1e400,"decimal":0.1234567890123456789,"zero":-0,\r\n\t"state":"before","state":"after","nested":{"text":"  **stars** before\u2028between\u2029after  ","escaped":"\\u0061","quoted":"say \\"hello\\"","slash":"\\/","backslash":"\\\\"}\r\n}',
  },
  { name: "array lexemes", text: "[9007199254740993,1e400,0.1234567890123456789,-0]" },
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
  async function renderMessage(text: string, isStreaming = false) {
    const container = createContainer();
    await renderToolFixture(
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

  it.each<{ name: string; text: string; fenced: boolean; tree: boolean; size?: number }>([
    ...(role === "assistant" ? jsonSources : jsonSources.slice(0, 1)).map(({ name, text }) => ({
      name,
      text,
      fenced: false,
      tree: true,
    })),
    ...[20_000, 20_001].map((size) => ({
      name: `${size}-character boundary`,
      size,
      text: '{"text":"' + "x".repeat(size - 11) + '"}',
      fenced: false,
      tree: size === 20_000,
    })),
    {
      name: "explicit fence",
      text: '{"id":9007199254740993,"text":"**stars**"}',
      fenced: true,
      tree: true,
    },
  ])("preserves $name in literal code and copy", async (scenario) => {
    const { text, fenced, tree } = scenario;
    if (scenario.size !== undefined) {
      expect(text).toHaveLength(scenario.size);
    }
    const source = fenced ? "```json\n" + text + "\n```" : text;
    const displayed = fenced ? (role === "toolResult" ? source : text + "\n") : text;
    const container = await renderMessage(source);
    expect(container.querySelectorAll("pre code")).toHaveLength(1);
    expect(container.querySelector(fenced ? "pre code" : ".chat-text pre code")?.textContent).toBe(
      displayed,
    );
    expect(container.querySelector("pre strong, .chat-text strong")).toBeNull();
    const copy = container.querySelector<HTMLElement>(".code-block-copy");
    if (!fenced) {
      if (role === "user") {
        expect(copy).toBeNull();
        expect(container.querySelector(".code-block-wrapper")).toBeNull();
      } else {
        expect(copy).not.toBeNull();
        expect(readMarkdownCodeBlockCopyText(copy!)).toBe(text);
      }
    }
    if (role === "assistant" && tree) {
      expect(container.querySelectorAll(".code-block-json-tree")).toHaveLength(1);
      expect(container.querySelector('[data-json-mode="tree"]')?.getAttribute("aria-pressed")).toBe(
        "true",
      );
      expect(container.querySelector('[data-json-mode="raw"]')?.getAttribute("aria-pressed")).toBe(
        "false",
      );
      expect(container.querySelector(".code-block-viewport pre code")?.textContent).toBe(displayed);
    } else {
      expect(container.querySelector(".code-block-json-tree, .code-block-json-mode")).toBeNull();
      if (role !== "assistant") {
        expect(container.querySelector(".code-block-wrap, .code-block-expand")).toBeNull();
      }
    }
    if (role === "toolResult" && !fenced) {
      expect(container.querySelector(".chat-tool-msg-body .chat-text pre code")?.textContent).toBe(
        text,
      );
      expect(container.querySelector(".chat-tool-msg-body details")).toBeNull();
    }
  });

  it.each([
    { text: '{"count": }', streaming: false },
    ...(role === "assistant" ? [{ text: "[9007199254740993,1e400,-0]", streaming: true }] : []),
  ])("keeps non-tree output literal: $text (streaming=$streaming)", async ({ text, streaming }) => {
    const container = await renderMessage(text, streaming);
    expect(container.querySelector(".code-block-json-tree, .code-block-json-mode")).toBeNull();
    expect(container.textContent).toContain(text);
  });
});

describe("tool JSON details", () => {
  async function openToolDetails(text: string) {
    const container = createContainer();
    const openSidebar = vi.fn<(content: SidebarContent) => void>();
    await renderToolFixture(
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

  it.each([
    jsonSources[0]!,
    {
      name: "oversized JSON",
      size: 20_001,
      text: '{"text":"**stars**' + "x".repeat(19_981) + '"}',
    },
    { name: "explicit fence", text: '```json\n{"id":9007199254740993,"text":"**stars**"}\n```' },
    { name: "invalid JSON", text: '{"count": }' },
  ])("preserves $name after opening tool details", async (scenario) => {
    const { text } = scenario;
    if ("size" in scenario) {
      expect(text).toHaveLength(scenario.size);
    }
    const panel = await openToolDetails(text);
    expect(panel.querySelector("pre code")?.textContent).toBe(text);
    expect(panel.querySelector("pre strong")).toBeNull();
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
  it.each(["user", "assistant"])("preserves %s JSON DOM across rerenders", (role) => {
    const container = createContainer();
    const message = {
      role,
      content: role === "user" ? '{"ok":true}' : '{"nested":{"ok":true}}',
      timestamp: 1,
    };
    renderJsonMessageGroup(container, message, role, { showToolCalls: true });
    const code = expectElement(container, ".chat-text pre code", HTMLElement);
    expect(code.textContent).toBe(message.content);
    const tree =
      role === "assistant" ? expectElement(container, ".code-block-json-tree", HTMLElement) : null;
    const root = tree ? expectElement(tree, ":scope > details", HTMLDetailsElement) : null;
    const nested = root
      ? expectElement(root, ".code-block-json-children details", HTMLDetailsElement)
      : null;
    if (role === "assistant") {
      expect(root?.open).toBe(true);
      expect(nested?.open).toBe(true);
      expectElement(nested!, ":scope > summary", HTMLElement).click();
      expect(nested?.open).toBe(false);
    } else {
      expect(container.querySelector(".chat-text button, .chat-text details")).toBeNull();
    }
    renderJsonMessageGroup(container, message, role, { showToolCalls: false });
    expect(container.querySelector(".chat-text pre code")).toBe(code);
    expect(code.textContent).toBe(message.content);
    if (role === "assistant") {
      expect(container.querySelector(".code-block-json-tree")).toBe(tree);
      expect(tree?.querySelector(":scope > details")).toBe(root);
      expect(root?.querySelector(".code-block-json-children details")).toBe(nested);
      expect(nested?.open).toBe(false);
      expect(container.querySelector(".code-block-viewport pre code")).toBe(code);
    } else {
      expect(container.querySelector(".code-block-wrapper")).toBeNull();
    }
  });
});
