import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { MarkdownBlocks } from "./markdown-blocks-owner.ts";
import { handleMarkdownCodeBlockClick } from "./markdown-code-blocks.ts";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

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
  document.body.innerHTML = toSanitizedMarkdownHtml(`\`\`\`ts\n${text}\n\`\`\``);
  const button = document.querySelector<HTMLButtonElement>(".code-block-copy");
  if (!button) {
    throw new Error("Expected Markdown code-copy button");
  }
  button.addEventListener("click", handleMarkdownCodeBlockClick);
  return button;
}

it("reobserves retained Markdown DOM while fencing scans queued before hide or disposal", async () => {
  const observed = new Set<Element>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(target: Element) {
        observed.add(target);
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {
        observed.clear();
      }
    },
  );
  const container = document.body.appendChild(document.createElement("div"));
  const content = toSanitizedMarkdownHtml(
    "```ts\nconst answer = 42;\n```\n\n| Name | Value |\n| --- | --- |\n| Alpha | One |",
    {
      codeBlockInteraction: "interactive",
      tableInteractions: "enabled",
    },
  );
  const section = document.createElement("section");
  section.className = "chat-text";
  section.innerHTML = content;
  container.append(section);
  let blocks = new MarkdownBlocks(container.querySelector("section")!);
  blocks.update(true);
  const code = container.querySelector("code");
  const tableViewport = container.querySelector(".markdown-table__viewport");

  try {
    blocks.dispose();
    await Promise.resolve();
    expect(observed.size).toBe(0);

    blocks = new MarkdownBlocks(container.querySelector("section")!);
    blocks.update(true);
    await Promise.resolve();
    expect(observed.size).toBe(4);
    expect(observed.has(code!)).toBe(true);
    expect(observed.has(tableViewport!)).toBe(true);

    blocks.update(false);
    expect(observed.size).toBe(0);
    blocks.update(true);
    await Promise.resolve();
    expect(container.querySelector("code")).toBe(code);
    expect(observed.has(code!)).toBe(true);
    expect(container.querySelector(".markdown-table__viewport")).toBe(tableViewport);
    expect(observed.has(tableViewport!)).toBe(true);
    expect(observed.size).toBe(4);

    blocks.update(false);
    await Promise.resolve();
    expect(observed.size).toBe(0);
    expect(container.querySelector("code")).toBe(code);
    blocks.update(true);
    blocks.update(false);
    await Promise.resolve();
    expect(observed.size).toBe(0);
    blocks.update(true);
    await Promise.resolve();
    expect(observed.size).toBe(4);
    expect(observed.has(code!)).toBe(true);
    expect(observed.has(tableViewport!)).toBe(true);
    blocks.update(true);
    blocks.dispose();
    await Promise.resolve();
    expect(observed.size).toBe(0);
  } finally {
    blocks.dispose();
    container.replaceChildren();
  }
});

it("does not remeasure settled Markdown while neighboring prose streams", async () => {
  vi.stubGlobal("ResizeObserver", undefined);
  const container = document.body.appendChild(document.createElement("div"));
  const content = toSanitizedMarkdownHtml(
    "```ts\nconst answer = 42;\n```\n\n| Name | Value |\n| --- | --- |\n| Alpha | One |",
    { codeBlockInteraction: "interactive", tableInteractions: "enabled" },
  );
  const section = document.createElement("section");
  section.className = "chat-text";
  section.innerHTML = content;
  const paragraph = document.createElement("p");
  paragraph.textContent = "First";
  section.append(paragraph);
  container.append(section);
  const blocks = new MarkdownBlocks(container.querySelector("section")!);
  blocks.update(true);
  await Promise.resolve();
  await Promise.resolve();
  const widths = vi.fn(() => 300);
  for (const node of container.querySelectorAll("code, .markdown-table__viewport")) {
    Object.defineProperty(node, "scrollWidth", { configurable: true, get: widths });
  }

  try {
    for (const prose of ["First paragraph", "First paragraph grows", "First paragraph grows"]) {
      paragraph.textContent = prose;
      blocks.update(true);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(container.querySelector("p:last-child")?.textContent).toBe("First paragraph grows");
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
  } finally {
    blocks.dispose();
    container.replaceChildren();
  }
});

describe("Markdown code-block clipboard feedback", () => {
  it.each([
    {
      name: "closing HTML tags",
      source: '<script>console.log("ok")</script>\n</style></textarea>',
    },
  ])("preserves $name when copying ordinary code", async ({ source }) => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const button = renderCodeCopyButton(source);

    button.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(writeText).toHaveBeenCalledWith(source);
  });

  it("ignores an older clipboard attempt that finishes after the latest denied copy", async () => {
    vi.useFakeTimers();
    let resolveFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    const writeText = vi
      .fn()
      .mockReturnValueOnce(firstWrite)
      .mockRejectedValueOnce(new DOMException("Clipboard access denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
    const button = renderCodeCopyButton();

    button.click();
    button.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(button.getAttribute("aria-label")).toBe("Copy failed");

    resolveFirstWrite();
    await vi.advanceTimersByTimeAsync(0);

    expect(button.classList.contains("copy-failed")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Copy failed");
    expect(button.classList.contains("copied")).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(button.getAttribute("aria-label")).toBe("Copy code");
  });

  it.each([
    { name: "a previous denied copy", firstSucceeds: false, firstResetAtMs: 2_000 },
    { name: "a previous successful copy", firstSucceeds: true, firstResetAtMs: 1_500 },
  ])("keeps the latest denied-copy feedback after $name", async (scenario) => {
    vi.useFakeTimers();
    const writeText = vi
      .fn()
      .mockRejectedValue(new DOMException("Clipboard access denied", "NotAllowedError"));
    if (scenario.firstSucceeds) {
      writeText.mockResolvedValueOnce(undefined);
    }
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
    const button = renderCodeCopyButton();

    button.click();
    await vi.advanceTimersByTimeAsync(1_000);
    button.click();
    await vi.advanceTimersByTimeAsync(scenario.firstResetAtMs - 1_000);

    expect(button.classList.contains("copy-failed")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Copy failed");

    await vi.advanceTimersByTimeAsync(3_000 - scenario.firstResetAtMs);

    expect(button.classList.contains("copy-failed")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Copy code");
  });

  it("keeps independent reset deadlines for different code-copy buttons", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new DOMException("Clipboard access denied")),
      },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
    const first = renderCodeCopyButton();
    const second = first.cloneNode(true) as HTMLButtonElement;
    second.addEventListener("click", handleMarkdownCodeBlockClick);
    document.body.append(second);

    first.click();
    await vi.advanceTimersByTimeAsync(500);
    second.click();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(first.getAttribute("aria-label")).toBe("Copy code");
    expect(second.getAttribute("aria-label")).toBe("Copy failed");

    second.remove();
    await vi.advanceTimersByTimeAsync(500);

    expect(second.getAttribute("aria-label")).toBe("Copy code");
  });
});

describe("toSanitizedMarkdownHtml code blocks", () => {
  const blockArt = "  ▀▀▀▀  \n  ▄▄▄▄  \n  ████  ";
  const jsonBlock = (lineCount: number) => {
    const values = Array.from({ length: lineCount - 2 }, (_, index) => `  ${index},`);
    values[values.length - 1] = values.at(-1)?.slice(0, -1) ?? "";
    return `\`\`\`json\n[\n${values.join("\n")}\n]\n\`\`\``;
  };

  async function expectCodeCopy(fragment: HTMLElement, text: string) {
    const writeText = vi.fn(async () => undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const schedule = vi.spyOn(globalThis, "setTimeout");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    fragment.addEventListener("click", handleMarkdownCodeBlockClick);
    try {
      document.body.append(fragment);
      const button = fragment.querySelector<HTMLButtonElement>(".code-block-copy");
      expect(button).toBeInstanceOf(HTMLButtonElement);
      button!.click();
      await vi.waitFor(() => expect(button!.getAttribute("aria-label")).toBe("Copied!"));
      expect(writeText).toHaveBeenCalledWith(text);
    } finally {
      fragment.remove();
      fragment.removeEventListener("click", handleMarkdownCodeBlockClick);
      for (const [index, [, delay]] of schedule.mock.calls.entries()) {
        if (delay === 1_500) {
          globalThis.clearTimeout(schedule.mock.results[index]?.value);
        }
      }
      schedule.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  }

  it("recognizes block art separated by Unicode line boundaries", () => {
    const rendered = toSanitizedMarkdownHtml("  ▀▀▀▀  \u2028  ▄▄▄▄  \u2029  ████  ");
    const fragment = htmlFragment(rendered);
    const code = fragment.querySelector("pre code.markdown-block-art");

    expect(fragment.querySelector("p")).toBeNull();
    expect(code?.textContent).toBe("  ▀▀▀▀  \n  ▄▄▄▄  \n  ████  ");
  });

  it("marks fenced block art without syntax highlighting", () => {
    const rendered = toSanitizedMarkdownHtml(`\`\`\`\n${blockArt}\n\`\`\``);
    const fragment = htmlFragment(rendered);
    const code = fragment.querySelector("pre code.markdown-block-art");

    expect(code?.classList.contains("hljs")).toBe(false);
    expect(code?.textContent).toBe(`${blockArt}\n`);
  });

  it("renders indented code blocks", async () => {
    // markdown-it requires a blank line before indented code
    const rendered = toSanitizedMarkdownHtml("text\n\n    indented code");
    const fragment = htmlFragment(rendered);

    expect(fragment.querySelector("p")?.textContent).toBe("text");
    expect(fragment.querySelector(".code-block-lang")?.textContent).toBe("Code");
    expect(fragment.querySelector("pre code")?.textContent).toBe("indented code\n");
    await expectCodeCopy(fragment, "indented code");
  });

  it("omits copy chrome when rendering user-preserved code blocks", () => {
    const source = `python3 - <<'PY'
import openpyxl

for ws in wb.worksheets:
  print(f"--- {ws.title} ---")
  rows = 0

  for row in ws.iter_rows(values_only=True):
      print(row)
PY
`;
    const rendered = toSanitizedMarkdownHtml(`\`\`\`bash\n${source}\`\`\``, {
      codeBlockChrome: "none",
    });
    const fragment = htmlFragment(rendered);

    expect(fragment.querySelector(".code-block-copy")).toBeNull();
    expect(fragment.querySelector(".code-block-wrapper")).toBeNull();
    expect(fragment.querySelector("pre code")?.textContent).toBe(source);
  });

  it("uses the singular hidden-line label for a single hidden line", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(jsonBlock(8), { codeBlockInteraction: "interactive" }),
    );
    const expand = fragment.querySelector(".code-block-expand");

    expect(expand?.textContent).toBe("1 hidden line");
    expect(expand?.getAttribute("aria-label")).toBe("Show 1 hidden line");
  });

  it.each(["TEXT"])("keeps long %s fences fully visible", (info) => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(`\`\`\`${info}\n${"prose line\n".repeat(20)}\`\`\``, {
        codeBlockInteraction: "interactive",
      }),
    );

    expect(fragment.querySelector(".code-block-wrapper.is-collapsible")).toBeNull();
    expect(fragment.querySelector(".code-block-expand")).toBeNull();
    expect(fragment.querySelector("pre code")?.textContent).toContain("prose line");
  });

  it("keeps long unlabeled fences collapsible", () => {
    const content = "unlabeled line\n".repeat(20);
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(`\`\`\`\n${content}\`\`\``, {
        codeBlockInteraction: "interactive",
      }),
    );

    expect(fragment.querySelector(".code-block-wrapper.is-collapsible")).toBeInstanceOf(
      HTMLDivElement,
    );
    expect(fragment.querySelector(".code-block-expand")?.textContent).toContain("13 hidden lines");
  });

  it("reveals a collapsed block through the shared click owner", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(jsonBlock(41), { codeBlockInteraction: "interactive" }),
    );
    const wrapper = fragment.querySelector(".code-block-wrapper");
    const expand = fragment.querySelector<HTMLButtonElement>(".code-block-expand");
    fragment.addEventListener("click", handleMarkdownCodeBlockClick);

    expand?.click();

    expect(wrapper?.classList.contains("is-expanded")).toBe(true);
    expect(expand?.getAttribute("aria-expanded")).toBe("true");
  });

  it("toggles wrapping through the shared click owner", () => {
    const fragment = htmlFragment(
      toSanitizedMarkdownHtml(jsonBlock(41), { codeBlockInteraction: "interactive" }),
    );
    const wrapper = fragment.querySelector(".code-block-wrapper");
    const wrap = fragment.querySelector<HTMLButtonElement>(".code-block-wrap");
    fragment.addEventListener("click", handleMarkdownCodeBlockClick);

    wrap?.click();
    expect(wrapper?.classList.contains("is-wrapped")).toBe(true);
    expect(wrap?.getAttribute("aria-pressed")).toBe("true");

    wrap?.click();
    expect(wrapper?.classList.contains("is-wrapped")).toBe(false);
    expect(wrap?.getAttribute("aria-pressed")).toBe("false");
  });

  it("localizes the hidden-line count and the language fallback", async () => {
    i18n.registerTranslation("pt-BR", {
      chat: {
        codeBlock: {
          languageFallback: "Código",
          hiddenLines: "{count} linhas ocultas",
        },
      },
    });
    await i18n.setLocale("pt-BR");
    try {
      const fragment = htmlFragment(
        toSanitizedMarkdownHtml(jsonBlock(41), { codeBlockInteraction: "interactive" }),
      );
      expect(fragment.querySelector(".code-block-expand")?.textContent).toContain(
        "34 linhas ocultas",
      );
      const unlabeled = htmlFragment(toSanitizedMarkdownHtml("```\nconteúdo\n```"));
      expect(unlabeled.querySelector(".code-block-lang")?.textContent).toBe("Código");
    } finally {
      await i18n.setLocale("en");
    }
  });

  it("keeps highlighted HTML code escaped", () => {
    const rendered = toSanitizedMarkdownHtml("```html\n<script>alert(1)</script>\n```");
    const fragment = htmlFragment(rendered);
    const code = fragment.querySelector("pre code");

    expect(code?.querySelector("script")).toBeNull();
    expect(code?.textContent).toBe("<script>alert(1)</script>\n");
    expect(code?.innerHTML).not.toContain("<script>");
  });
});
