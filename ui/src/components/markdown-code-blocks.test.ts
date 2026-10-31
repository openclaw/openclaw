import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { i18n } from "../i18n/index.ts";
import { mockDocumentVisibility } from "../test-helpers/mock-cleanup.ts";
import { restorePropertyDescriptor } from "../test-helpers/property-descriptor.ts";
import { MarkdownBlocks } from "./markdown-blocks-owner.ts";
import {
  handleMarkdownCodeBlockClick,
  readMarkdownCodeBlockCopyText,
} from "./markdown-code-blocks.ts";
import {
  splitCodeHighlightHtml,
  type CodeHighlightRequest,
} from "./markdown-code-highlight-chunks.ts";
import { parseMarkdownJson } from "./markdown-json.ts";
import type { MarkdownRenderOptions } from "./markdown-render-options.ts";
import { htmlFragment, toStreamingMarkdownParts } from "./markdown.test-support.ts";
import { toSanitizedJsonHtml, toSanitizedMarkdownHtml } from "./markdown.ts";

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restorePropertyDescriptor(document, "execCommand", originalExecCommand);
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

it.each(["visible", "hidden"] as const)(
  "gates direct Markdown owners on tab visibility without losing pane intent (initially %s)",
  async (initial) => {
    const show = mockDocumentVisibility(initial);
    const observations: Set<Element>[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly targets = new Set<Element>();
        constructor() {
          observations.push(this.targets);
        }
        observe = (target: Element) => this.targets.add(target);
        unobserve = (target: Element) => this.targets.delete(target);
        disconnect = () => this.targets.clear();
      },
    );
    const { section, blocks } = mountBlocks();
    const code = section.querySelector("code")!;
    const observed = () => observations.flatMap((targets) => Array.from(targets));
    blocks.update(true);
    await Promise.resolve();
    expect(observed().includes(code)).toBe(initial === "visible");

    show("hidden");
    expect(observed()).toHaveLength(0);
    // Custodian republishes active content; it must not restart hidden work.
    blocks.update(true);
    blocks.update(true);
    await Promise.resolve();
    expect(observed()).toHaveLength(0);
    show("visible");
    await Promise.resolve();
    expect(observed()).toContain(code);
    expect(section.querySelector("code")).toBe(code);

    show("hidden");
    blocks.update(false);
    show("visible");
    await Promise.resolve();
    expect(observed()).toHaveLength(0);

    blocks.update(true);
    blocks.dispose();
    await Promise.resolve();
    expect(observed()).toHaveLength(0);
    show("hidden");
    show("visible");
    await Promise.resolve();
    expect(observed()).toHaveLength(0);
  },
);

it("follows the rendering tab when a template reader is adopted after activation", async () => {
  const show = mockDocumentVisibility("visible");
  const observed = new Set<Element>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = (target: Element) => observed.add(target);
      unobserve = (target: Element) => observed.delete(target);
      disconnect = () => observed.clear();
    },
  );
  const template = document.createElement("template");
  template.innerHTML =
    '<article><div class="code-block-wrapper"><pre class="code-block-viewport"><code>const answer = 42;</code></pre></div></article>';
  const root = template.content.firstElementChild as HTMLElement;
  expect(root.ownerDocument).not.toBe(document);
  expect(root.ownerDocument.defaultView).toBeNull();
  const blocks = ownBlocks(root);
  blocks.update(true);
  document.body.append(root);
  await Promise.resolve();
  const code = root.querySelector("code")!;
  expect(observed).toContain(code);

  show("hidden");
  expect(observed.size).toBe(0);
  show("visible");
  await Promise.resolve();
  expect(observed).toContain(code);
  expect(root.querySelector("code")).toBe(code);
  blocks.dispose();
  expect(observed.size).toBe(0);
});

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

it("defers code overflow measurement out of resize delivery and retires it on hide", async () => {
  vi.useFakeTimers();
  const observations = new Map<Element, () => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: (entries: { target: Element }[]) => void) {}
      observe(target: Element) {
        observations.set(target, () => this.callback([{ target }]));
      }
      unobserve(target: Element) {
        observations.delete(target);
      }
      disconnect() {}
    },
  );
  const { container, blocks } = mountBlocks();
  blocks.update(true);
  await Promise.resolve();
  const wrapper = container.querySelector<HTMLElement>(".code-block-wrapper")!;
  const viewport = wrapper.querySelector<HTMLElement>(".code-block-viewport")!;
  const code = viewport.querySelector("code")!;
  Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 100 });
  const width = vi.fn(() => 300);
  Object.defineProperty(code, "scrollWidth", { configurable: true, get: width });
  observations.get(code)!();
  expect(width).not.toHaveBeenCalled();
  expect(wrapper.classList.contains("has-horizontal-overflow")).toBe(false);
  vi.advanceTimersToNextFrame();
  expect(wrapper.classList.contains("has-horizontal-overflow")).toBe(true);

  width.mockReturnValue(50).mockClear();
  observations.get(code)!();
  blocks.update(false);
  vi.advanceTimersToNextFrame();
  expect(width).not.toHaveBeenCalled();
  expect(wrapper.classList.contains("has-horizontal-overflow")).toBe(true);
});

it("splits highlighted code into bounded, balanced fragments with exact source offsets", () => {
  const source = "comment 🦞 & < > \" ' text\n".repeat(400);
  const escaped = source
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
  const { chunks, previewEnd } = splitCodeHighlightHtml(
    `<span class="hljs-comment">${escaped}</span>`,
  );
  expect(previewEnd).toBe("comment 🦞 & < > \" ' text\n".repeat(7).length);
  let from = 0;
  for (const chunk of chunks) {
    const fragment = htmlFragment(chunk.html);
    expect(fragment.textContent).toBe(source.slice(from, chunk.to));
    expect(fragment.querySelector(".hljs-comment")?.textContent).toBe(fragment.textContent);
    expect(fragment.querySelectorAll("span").length).toBeLessThanOrEqual(128);
    expect(chunk.to - from).toBeLessThanOrEqual(2_049);
    from = chunk.to;
  }
  expect(chunks.at(-1)?.to).toBe(source.length);
});

it("shares one worker for long fences and preserves complete text through reveal and retirement", async () => {
  vi.useFakeTimers();
  const workers: TestWorker[] = [];
  const requests: { worker: TestWorker; data: CodeHighlightRequest }[] = [];
  class TestWorker extends EventTarget {
    terminate = vi.fn();
    constructor() {
      super();
      workers.push(this);
    }
    postMessage(data: CodeHighlightRequest) {
      requests.push({ worker: this, data });
    }
    deliver(data: CodeHighlightRequest) {
      const escaped = data.source
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      this.dispatchEvent(
        new MessageEvent("message", {
          data: {
            id: data.id,
            ...splitCodeHighlightHtml(`<span class="hljs-comment">${escaped}</span>`),
            highlighted: true,
          },
        }),
      );
    }
  }
  vi.stubGlobal("Worker", TestWorker);
  const source = "source line\n".repeat(400);
  const jsonSource = JSON.stringify(
    Array.from({ length: 400 }, () => 'escaped \\n " < > & 🦞'),
    null,
    2,
  ).replaceAll("\n", "\r\n");
  const json = parseMarkdownJson(jsonSource);
  if (!json) {
    throw new Error("Invalid JSON fixture");
  }
  const sources = [source, jsonSource];
  const roots = sources.map((value, index) => {
    const root = document.body.appendChild(document.createElement("section"));
    root.className = "chat-text";
    root.innerHTML =
      index === 0
        ? toSanitizedMarkdownHtml(`\`\`\`ts\n${value}\`\`\``, {
            codeBlockInteraction: "interactive",
          })
        : toSanitizedJsonHtml(json, { codeBlockInteraction: "interactive" });
    root.addEventListener("click", handleMarkdownCodeBlockClick);
    root.querySelector<HTMLButtonElement>('[data-json-mode="raw"]')?.click();
    return root;
  });
  const owners = roots.map(ownBlocks);
  try {
    owners.forEach((owner) => owner.update(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(roots[1]!.querySelector("code")?.textContent).toBe(jsonSource);
    expect(readMarkdownCodeBlockCopyText(roots[1]!.querySelector(".code-block-copy")!)).toBe(
      jsonSource,
    );
    requests.forEach(({ worker, data }) => worker.deliver(data));
    await vi.advanceTimersByTimeAsync(2_000);
    for (const [index, root] of roots.entries()) {
      const value = sources[index]!;
      const code = root.querySelector("code")!;
      expect(code.textContent).toBe(value);
      expect(code.querySelector(".hljs-comment")?.textContent).toBe(
        value.split("\n").slice(0, 7).join("\n") + "\n",
      );
      expect(readMarkdownCodeBlockCopyText(root.querySelector(".code-block-copy")!)).toBe(
        index === 0 ? value.slice(0, -1) : value,
      );
    }
    roots[0]!.appendChild(document.createElement("p")).textContent = "Unrelated prose";
    owners[0]!.update(true);
    roots[0]!.querySelector<HTMLButtonElement>(".code-block-expand")!.click();
    const code = roots[0]!.querySelector("code")!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(code.lastChild!, 100);
    range.setEnd(code.lastChild!, 120);
    selection.removeAllRanges();
    selection.addRange(range);
    onTestFinished(() => selection.removeAllRanges());
    const selected = selection.toString();
    expect(selected).toHaveLength(20);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(selection.toString()).toBe(selected);
    selection.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(roots[0]!.querySelector("code")?.textContent).toBe(source);
    expect(
      [...roots[0]!.querySelectorAll(".hljs-comment")].map((node) => node.textContent).join(""),
    ).toBe(source);
    roots[1]!.querySelector<HTMLButtonElement>(".code-block-expand")!.click();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(roots[1]!.querySelector("code")?.textContent).toBe(jsonSource);
    expect(
      [...roots[1]!.querySelectorAll(".hljs-comment")].map((node) => node.textContent).join(""),
    ).toBe(jsonSource);
    expect(readMarkdownCodeBlockCopyText(roots[1]!.querySelector(".code-block-copy")!)).toBe(
      jsonSource,
    );
    expect(requests).toHaveLength(2);
    owners.forEach((owner) => owner.update(false));
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    roots[0]!.innerHTML = toSanitizedMarkdownHtml(
      `\`\`\`ts\n${source.replaceAll("source", "new")}\`\`\``,
      { codeBlockInteraction: "interactive" },
    );
    owners[0]!.update(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(3);
    owners[0]!.update(false);
    const latest = requests[2]!;
    latest.worker.deliver(latest.data);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(roots[0]!.querySelector("code")?.textContent).toBe(source.replaceAll("source", "new"));
    expect(roots[0]!.querySelector("code span")).toBeNull();
  } finally {
    owners.forEach((owner) => owner.dispose());
  }
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
