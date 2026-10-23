import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { i18n } from "../i18n/index.ts";
import { MarkdownBlocks } from "./markdown-blocks-owner.ts";
import {
  handleMarkdownCodeBlockClick,
  readMarkdownCodeBlockCopyText,
} from "./markdown-code-blocks.ts";
import { parseMarkdownJson } from "./markdown-json.ts";
import type { MarkdownRenderOptions } from "./markdown-render-options.ts";
import { htmlFragment } from "./markdown.test-support.ts";
import {
  toSanitizedJsonHtml,
  toSanitizedMarkdownHtml,
  toStreamingMarkdownParts,
} from "./markdown.ts";

function render(source: string, options?: MarkdownRenderOptions) {
  return interactiveHtml(toSanitizedMarkdownHtml(source, options));
}

function interactiveHtml(html: string) {
  const fragment = htmlFragment(html);
  fragment.addEventListener("click", handleMarkdownCodeBlockClick);
  return fragment;
}

const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalExecCommand) {
    Object.defineProperty(document, "execCommand", originalExecCommand);
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
  document.body.replaceChildren();
});

function renderCodeCopyButton(text = "const answer = 42;"): HTMLButtonElement {
  const fragment = render(`\`\`\`ts\n${text}\n\`\`\``);
  document.body.append(fragment);
  const button = fragment.querySelector<HTMLButtonElement>(".code-block-copy");
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button!;
}

function ownBlocks(root: HTMLElement) {
  const blocks = new MarkdownBlocks(root);
  onTestFinished(() => blocks.dispose());
  return blocks;
}

function mountBlocks() {
  const section = document.body.appendChild(document.createElement("section"));
  section.className = "chat-text";
  section.innerHTML = toSanitizedMarkdownHtml(
    "```ts\nconst answer = 42;\n```\n\n| Name | Value |\n| --- | --- |\n| Alpha | One |",
    { codeBlockInteraction: "interactive", tableInteractions: "enabled" },
  );
  return { container: section, section, blocks: ownBlocks(section) };
}
const denied = new DOMException("Clipboard access denied", "NotAllowedError");
function mockClipboard(writeText = vi.fn().mockRejectedValue(denied), fallback = true) {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  if (fallback) {
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
  }
  return writeText;
}
function expectCopyFailed(button: HTMLButtonElement) {
  expect(button.classList.contains("copy-failed")).toBe(true);
  expect(button.getAttribute("aria-label")).toBe("Copy failed");
}
async function copy(button: HTMLButtonElement, elapsed = 0) {
  button.click();
  await vi.advanceTimersByTimeAsync(elapsed);
}

it("reobserves retained Markdown DOM while fencing scans queued before hide or disposal", async () => {
  const observed = new Set<Element>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = (target: Element) => observed.add(target);
      unobserve = (target: Element) => observed.delete(target);
      disconnect = () => observed.clear();
    },
  );
  const { container, section, blocks: initialBlocks } = mountBlocks();
  let blocks = initialBlocks;
  blocks.update(true);
  const code = container.querySelector("code");
  const tableViewport = container.querySelector(".markdown-table__viewport");
  const expectObserved = (count: number) => {
    expect(observed.size).toBe(count);
    if (count) {
      expect([...observed]).toEqual(expect.arrayContaining([code, tableViewport]));
    }
  };
  const settleObserved = async (count: number) => {
    await Promise.resolve();
    expectObserved(count);
  };
  const show = async () => {
    blocks.update(true);
    await settleObserved(4);
  };

  blocks.dispose();
  await settleObserved(0);
  blocks = ownBlocks(section);
  await show();

  blocks.update(false);
  expectObserved(0);
  await show();
  expect(container.querySelector("code")).toBe(code);
  expect(container.querySelector(".markdown-table__viewport")).toBe(tableViewport);

  blocks.update(false);
  await settleObserved(0);
  expect(container.querySelector("code")).toBe(code);
  blocks.update(true);
  blocks.update(false);
  await settleObserved(0);
  await show();
  blocks.update(true);
  blocks.dispose();
  await settleObserved(0);
});

it("does not remeasure settled Markdown while neighboring prose streams", async () => {
  const { container, section, blocks } = mountBlocks();
  const paragraph = document.createElement("p");
  paragraph.textContent = "First";
  section.append(paragraph);
  blocks.update(true);
  await Promise.resolve();
  await Promise.resolve();
  const widths = vi.fn(() => 300);
  for (const node of container.querySelectorAll("code, .markdown-table__viewport")) {
    Object.defineProperty(node, "scrollWidth", { configurable: true, get: widths });
  }

  for (const prose of ["First paragraph", "First paragraph grows", "First paragraph grows"]) {
    paragraph.textContent = prose;
    blocks.update(true);
    await Promise.resolve();
    await Promise.resolve();
  }
  expectText(container, "p:last-child").toBe("First paragraph grows");
  expect(widths).not.toHaveBeenCalled();

  const wrapper = container.querySelector<HTMLElement>(".code-block-wrapper")!;
  const expand = document.createElement("button");
  expand.className = "code-block-expand";
  wrapper.append(expand);
  await Promise.resolve();
  await Promise.resolve();
  const viewport = wrapper.querySelector<HTMLElement>(".code-block-viewport")!;
  expect(viewport.id).not.toBe("");
  expect(expand.getAttribute("aria-controls")).toBe(viewport.id);
});

function expectText(root: ParentNode, selector: string) {
  return expect(root.querySelector(selector)?.textContent);
}

it("ignores an older clipboard attempt that finishes after the latest denied copy", async () => {
  const firstWrite = createDeferred();
  mockClipboard(vi.fn().mockReturnValueOnce(firstWrite.promise).mockRejectedValueOnce(denied));
  const button = renderCodeCopyButton();

  button.click();
  button.click();
  await vi.advanceTimersByTimeAsync(0);

  expect(button.getAttribute("aria-label")).toBe("Copy failed");

  firstWrite.resolve();
  await vi.advanceTimersByTimeAsync(0);

  expectCopyFailed(button);
  expect(button.classList.contains("copied")).toBe(false);

  await vi.advanceTimersByTimeAsync(2_000);

  expect(button.getAttribute("aria-label")).toBe("Copy code");
});

it.each([
  { name: "a previous denied copy", firstSucceeds: false, firstResetAtMs: 2_000 },
  { name: "a previous successful copy", firstSucceeds: true, firstResetAtMs: 1_500 },
])("keeps the latest denied-copy feedback after $name", async (scenario) => {
  const writeText = mockClipboard();
  if (scenario.firstSucceeds) {
    writeText.mockResolvedValueOnce(undefined);
  }
  const button = renderCodeCopyButton();

  await copy(button, 1_000);
  await copy(button, scenario.firstResetAtMs - 1_000);

  expectCopyFailed(button);

  await vi.advanceTimersByTimeAsync(3_000 - scenario.firstResetAtMs);

  expect(button.classList.contains("copy-failed")).toBe(false);
  expect(button.getAttribute("aria-label")).toBe("Copy code");
});

it("keeps independent reset deadlines for different code-copy buttons", async () => {
  mockClipboard(vi.fn().mockRejectedValue(new DOMException("Clipboard access denied")));
  const first = renderCodeCopyButton();
  const second = first.cloneNode(true) as HTMLButtonElement;
  second.addEventListener("click", handleMarkdownCodeBlockClick);
  document.body.append(second);

  await copy(first, 500);
  await copy(second, 1_500);

  expect(first.getAttribute("aria-label")).toBe("Copy code");
  expect(second.getAttribute("aria-label")).toBe("Copy failed");

  second.remove();
  await vi.advanceTimersByTimeAsync(500);

  expect(second.getAttribute("aria-label")).toBe("Copy code");
});
const interactive = (lines = 41) => {
  const values = Array.from({ length: lines - 2 }, (_, i) => i);
  const json = JSON.stringify(values, null, 2);
  return render(`\`\`\`json\n${json}\n\`\`\``, { codeBlockInteraction: "interactive" });
};

it.each([true, false])("keeps code literal without HTML children (block art=%s)", (blockArt) => {
  const fragment = render(
    blockArt ? "  ▀▀▀▀  \u2028  ▄▄▄▄  \u2029  ████  " : "```html\n<script>alert(1)</script>\n```",
  );
  const code = fragment.querySelector(`pre code${blockArt ? ".markdown-block-art" : ""}`);
  expect(fragment.querySelector(blockArt ? "p" : "script")).toBeNull();
  expect(code?.textContent).toBe(
    blockArt ? "  ▀▀▀▀  \n  ▄▄▄▄  \n  ████  " : "<script>alert(1)</script>\n",
  );
  expect(code?.innerHTML).not.toContain("<script>");
});

it.each([
  ["ordinary HTML", '<script>console.log("ok")</script>\n</style></textarea>', false],
  ["indented code", "indented code", true],
] as const)("renders and copies %s literally", async (_, source, indented) => {
  const fragment = render(indented ? `text\n\n    ${source}` : `\`\`\`ts\n${source}\n\`\`\``);
  if (indented) {
    expect(
      ["p", ".code-block-lang", "pre code"].map((tag) => fragment.querySelector(tag)?.textContent),
    ).toEqual(["text", "Code", "indented code\n"]);
  }
  const writeText = mockClipboard(vi.fn().mockResolvedValue(undefined), false);
  document.body.append(fragment);
  const button = fragment.querySelector<HTMLButtonElement>(".code-block-copy");
  expect(button).toBeInstanceOf(HTMLButtonElement);
  await copy(button!);
  expect(button!.getAttribute("aria-label")).toBe("Copied!");
  expect(writeText).toHaveBeenCalledWith(source);
});

it("uses the singular hidden-line label for a single hidden line", () => {
  const fragment = interactive(8);
  const expand = fragment.querySelector(".code-block-expand");

  expect(expand?.textContent).toBe("1 hidden line");
  expect(expand?.getAttribute("aria-label")).toBe("Show 1 hidden line");
});

it("keeps long TEXT fences fully visible", () => {
  const fragment = render(`\`\`\`TEXT\n${"prose line\n".repeat(20)}\`\`\``, {
    codeBlockInteraction: "interactive",
  });

  expect(fragment.querySelector(".code-block-wrapper.is-collapsible")).toBeNull();
  expect(fragment.querySelector(".code-block-expand")).toBeNull();
  expectText(fragment, "pre code").toContain("prose line");
});

it.each([
  ["expand", "is-expanded", "aria-expanded", [true]],
  ["wrap", "is-wrapped", "aria-pressed", [true, false]],
] as const)("handles %s through the shared click owner", (action, className, attribute, states) => {
  const fragment = interactive();
  document.body.append(fragment);
  const outside = document.body.appendChild(document.createElement("button"));
  outside.focus();
  const wrapper = fragment.querySelector(".code-block-wrapper");
  const button = fragment.querySelector<HTMLButtonElement>(`.code-block-${action}`);
  for (const state of states) {
    button?.click();
    expect(document.activeElement).toBe(outside);
    expect(wrapper?.classList.contains(className)).toBe(state);
    expect(button?.getAttribute(attribute)).toBe(String(state));
  }
});

it("localizes the hidden-line count and the language fallback", async () => {
  const codeBlock = { languageFallback: "Código", hiddenLines: "{count} linhas ocultas" };
  i18n.registerTranslation("pt-BR", { chat: { codeBlock } });
  await i18n.setLocale("pt-BR");
  try {
    const fragment = interactive();
    expectText(fragment, ".code-block-expand").toContain("34 linhas ocultas");
    const unlabeled = render("```\nconteúdo\n```");
    expectText(unlabeled, ".code-block-lang").toBe("Código");
  } finally {
    await i18n.setLocale("en");
  }
});

describe("source-preserving JSON tree", () => {
  const jsonOptions = { codeBlockInteraction: "interactive" } as const;
  const find = (selector: string) => document.body.querySelector<HTMLElement>(selector);
  const texts = (selector: string) =>
    [...document.body.querySelectorAll(selector)].map((node) => node.textContent);
  function expectSource(source: string, suffix = "") {
    expect(find("pre code")?.textContent).toBe(source + suffix);
    expect(readMarkdownCodeBlockCopyText(find(".code-block-copy")!)).toBe(source);
  }
  function renderJson(source: string, fenced = false) {
    const json = parseMarkdownJson(source);
    if (!json) {
      throw new Error("Expected valid JSON fixture");
    }
    document.body.replaceChildren(
      fenced
        ? render("```json\n" + source + "\n```", jsonOptions)
        : interactiveHtml(toSanitizedJsonHtml(json, jsonOptions)),
    );
  }

  it.each([
    {
      source: String.raw`{"2":1.00,"1":1E+03,"a":9007199254740993,"a":1e400,"nested":{"a":-0,"a":1e-999}}`,
      keys: ['"2"', '"1"', '"a"', '"a"', '"nested"', '"a"', '"a"'],
      literals: ["1.00", "1E+03", "9007199254740993", "1e400", "-0", "1e-999"],
    },
    {
      source: '\t{\n\t\t"nested": {\n\t\t\t"text": "  keep these spaces  "\n\t\t}\n\t}',
      keys: ['"nested"', '"text"'],
      literals: [],
    },
  ])(
    "preserves source lexemes and indentation in Tree, Raw and Copy: $source",
    ({ source, keys, literals }) => {
      for (const fenced of [false, true]) {
        renderJson(source, fenced);
        expect(texts(".code-block-json-key")).toEqual(keys);
        expect(texts(".code-block-json-value--literal")).toEqual(literals);
        find('[data-json-mode="raw"]')!.click();
        expect(find(".code-block-wrapper")?.classList.contains("is-json-raw")).toBe(true);
        expectSource(source, fenced ? "\n" : "");
      }
    },
  );

  it("keeps literal escapes, whitespace, Unicode separators and HTML inert", () => {
    const source =
      ' \r\n{ "\\u0061": "\\u0061", "html": "</code><img src=x onerror=alert(1)>", "text": "**literal**' +
      "\u2028\u2029" +
      '" }\r\n ';
    renderJson(source);
    expectSource(source);
    expect(find(".code-block-json-key")?.textContent).toBe('"\\u0061"');
    expect(find(".code-block-json-value--string")?.textContent).toBe('"\\u0061"');
    expect(find("img, script, strong")).toBeNull();
  });

  it("switches views through the existing owner without replacing source or node state", () => {
    renderJson('{"nested":{"value":true}}');
    const node = document.querySelectorAll<HTMLDetailsElement>(".code-block-json-node")[1]!;
    node.querySelector<HTMLElement>("summary")!.click();
    expect(node.open).toBe(false);
    const raw = find('[data-json-mode="raw"]')!;
    const tree = find('[data-json-mode="tree"]')!;
    raw.click();
    expect(raw.getAttribute("aria-pressed")).toBe("true");
    expect(tree.getAttribute("aria-pressed")).toBe("false");
    expect(find(".code-block-wrapper")?.classList.contains("is-json-raw")).toBe(true);
    tree.click();
    expect(node.open).toBe(false);
    expect(document.querySelectorAll(".code-block-json-node")[1]).toBe(node);
    expect(find(".code-block-wrapper")?.classList.contains("is-json-raw")).toBe(false);
  });

  it("renders empty containers and null", () => {
    const source = '{"empty":[],"nothing":null}';
    renderJson(source);
    expect(find(".code-block-json-tree")).not.toBeNull();
    expect(find("pre code")?.textContent).toBe(source);
  });

  it.each(['{"trailing":1,}', '{/*comment*/"a":1}', '{"a":1} trailing'])(
    "leaves invalid JSON on the existing raw fence path: %s",
    (source) => {
      expect(parseMarkdownJson(source)).toBeNull();
      document.body.innerHTML = toSanitizedMarkdownHtml(
        "```json\n" + source + "\n```",
        jsonOptions,
      );
      expect(find(".code-block-json-tree")).toBeNull();
      expect(find("pre code")?.textContent).toBe(source + "\n");
    },
  );

  it.each([
    "[".repeat(1000) + "0" + "]".repeat(1000),
    "[" + "0,".repeat(3000) + "0]",
    " ".repeat(20_000) + "{}",
  ])("keeps over-budget trees literal and complete", (source) => {
    renderJson(source);
    expect(find(".code-block-json-tree, strong")).toBeNull();
    expectSource(source);
  });

  it("leaves inputs above the shared parsing limit to the existing literal-text renderer", () => {
    const source = '{"text":"**literal** ' + "x".repeat(40_000) + '"}';
    expect(parseMarkdownJson(source)).toBeNull();
    document.body.innerHTML = toSanitizedMarkdownHtml(source, jsonOptions);
    expect(find("strong")).toBeNull();
    expect(document.body.textContent).toBe(source);
  });

  it("does not emit inert view controls in static/user hosts", () => {
    const json = parseMarkdownJson('{"a":1}')!;
    for (const options of [{}, { codeBlockChrome: "none" as const }]) {
      document.body.innerHTML = toSanitizedJsonHtml(json, options);
      expect(find(".code-block-json-mode")).toBeNull();
      expect(find("pre code")?.textContent).toBe(json.text);
    }
  });

  it("waits for a closing fence before offering the tree", () => {
    const source = '```json\n{"a":1}';
    document.body.innerHTML = toStreamingMarkdownParts(source, jsonOptions).join("");
    expect(find(".code-block-json-tree")).toBeNull();
    document.body.innerHTML = toStreamingMarkdownParts(source + "\n```", jsonOptions).join("");
    expect(find(".code-block-json-tree")).not.toBeNull();
  });
});
