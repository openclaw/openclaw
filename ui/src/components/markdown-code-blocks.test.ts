import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { MarkdownBlocks } from "./markdown-blocks-owner.ts";
import { handleMarkdownCodeBlockClick } from "./markdown-code-blocks.ts";
import type { MarkdownRenderOptions } from "./markdown-render-options.ts";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

function render(source: string, options?: MarkdownRenderOptions) {
  const fragment = htmlFragment(toSanitizedMarkdownHtml(source, options));
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
  let resolveFirstWrite!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    resolveFirstWrite = resolve;
  });
  mockClipboard(vi.fn().mockReturnValueOnce(firstWrite).mockRejectedValueOnce(denied));
  const button = renderCodeCopyButton();

  button.click();
  button.click();
  await vi.advanceTimersByTimeAsync(0);

  expect(button.getAttribute("aria-label")).toBe("Copy failed");

  resolveFirstWrite();
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
  const wrapper = fragment.querySelector(".code-block-wrapper");
  const button = fragment.querySelector<HTMLButtonElement>(`.code-block-${action}`);
  for (const state of states) {
    button?.click();
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
