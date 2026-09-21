/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import {
  handleMarkdownCodeBlockClick,
  readMarkdownCodeBlockCopyText,
} from "./markdown-code-blocks.ts";
import { parseMarkdownJson } from "./markdown-json.ts";
import {
  toSanitizedJsonHtml,
  toSanitizedMarkdownHtml,
  toStreamingMarkdownParts,
} from "./markdown.ts";

const interactive = { codeBlockInteraction: "interactive" } as const;
afterEach(() => {
  document.body.replaceChildren();
});

function renderJson(source: string, fenced = false) {
  const json = parseMarkdownJson(source);
  if (!json) {
    throw new Error("Expected valid JSON fixture");
  }
  document.body.innerHTML = fenced
    ? toSanitizedMarkdownHtml("```json\n" + source + "\n```", interactive)
    : toSanitizedJsonHtml(json, interactive);
  return document.body;
}

describe("source-preserving JSON tree", () => {
  it.each([false, true])(
    "retains duplicate members, key order and numeric lexemes (fenced=%s)",
    (fenced) => {
      const source = String.raw`{"2":1.00,"1":1E+03,"a":9007199254740993,"a":1e400,"nested":{"a":-0,"a":1e-999}}`;
      const body = renderJson(source, fenced);
      expect(
        [...body.querySelectorAll(".code-block-json-key")].map((node) => node.textContent),
      ).toEqual(['"2"', '"1"', '"a"', '"a"', '"nested"', '"a"', '"a"']);
      expect(
        [...body.querySelectorAll(".code-block-json-value--literal")].map(
          (node) => node.textContent,
        ),
      ).toEqual(["1.00", "1E+03", "9007199254740993", "1e400", "-0", "1e-999"]);
      const button = body.querySelector<HTMLElement>(".code-block-copy")!;
      expect(readMarkdownCodeBlockCopyText(button)).toBe(source);
    },
  );

  it("keeps literal escapes, whitespace, Unicode separators and HTML inert", () => {
    const source =
      ' \r\n{ "\\u0061": "\\u0061", "html": "</code><img src=x onerror=alert(1)>", "text": "**literal**' +
      "\u2028\u2029" +
      '" }\r\n ';
    const body = renderJson(source);
    expect(body.querySelector("pre code")?.textContent).toBe(source);
    expect(body.querySelector(".code-block-json-key")?.textContent).toBe('"\\u0061"');
    expect(body.querySelector(".code-block-json-value--string")?.textContent).toBe('"\\u0061"');
    expect(body.querySelector("img, script, strong")).toBeNull();
    expect(
      readMarkdownCodeBlockCopyText(body.querySelector<HTMLElement>(".code-block-copy")!),
    ).toBe(source);
  });

  it.each([false, true])("preserves authored indentation in Raw and Copy (fenced=%s)", (fenced) => {
    const source = '\t{\n\t\t"nested": {\n\t\t\t"text": "  keep these spaces  "\n\t\t}\n\t}';
    const body = renderJson(source, fenced);
    body.addEventListener("click", handleMarkdownCodeBlockClick);
    try {
      body.querySelector<HTMLButtonElement>('[data-json-mode="raw"]')!.click();
      expect(body.querySelector(".code-block-wrapper")?.classList.contains("is-json-raw")).toBe(
        true,
      );
      expect(body.querySelector("pre code")?.textContent).toBe(source + (fenced ? "\n" : ""));
      expect(
        readMarkdownCodeBlockCopyText(body.querySelector<HTMLElement>(".code-block-copy")!),
      ).toBe(source);
    } finally {
      body.removeEventListener("click", handleMarkdownCodeBlockClick);
    }
  });

  it("switches views through the existing owner without replacing source or node state", () => {
    const body = renderJson('{"nested":{"value":true}}');
    body.addEventListener("click", handleMarkdownCodeBlockClick);
    try {
      const node = body.querySelectorAll<HTMLDetailsElement>(".code-block-json-node")[1]!;
      node.querySelector<HTMLElement>("summary")!.click();
      expect(node.open).toBe(false);
      const raw = body.querySelector<HTMLButtonElement>('[data-json-mode="raw"]')!;
      const tree = body.querySelector<HTMLButtonElement>('[data-json-mode="tree"]')!;
      raw.click();
      expect(raw.getAttribute("aria-pressed")).toBe("true");
      expect(tree.getAttribute("aria-pressed")).toBe("false");
      expect(body.querySelector(".code-block-wrapper")?.classList.contains("is-json-raw")).toBe(
        true,
      );
      tree.click();
      expect(node.open).toBe(false);
      expect(body.querySelectorAll(".code-block-json-node")[1]).toBe(node);
      expect(body.querySelector(".code-block-wrapper")?.classList.contains("is-json-raw")).toBe(
        false,
      );
    } finally {
      body.removeEventListener("click", handleMarkdownCodeBlockClick);
    }
  });

  it.each(["{}", "[]", '{"empty":[],"nothing":null}'])(
    "renders empty containers and null: %s",
    (source) => {
      const body = renderJson(source);
      expect(body.querySelector(".code-block-json-tree")).not.toBeNull();
      expect(body.querySelector("pre code")?.textContent).toBe(source);
    },
  );

  it.each(['{"missing":}', '{"trailing":1,}', '{/*comment*/"a":1}', '{"a":1} trailing'])(
    "leaves invalid JSON on the existing raw fence path: %s",
    (source) => {
      expect(parseMarkdownJson(source)).toBeNull();
      document.body.innerHTML = toSanitizedMarkdownHtml(
        "```json\n" + source + "\n```",
        interactive,
      );
      expect(document.querySelector(".code-block-json-tree")).toBeNull();
      expect(document.querySelector("pre code")?.textContent).toBe(source + "\n");
    },
  );

  it.each(["[".repeat(1000) + "0" + "]".repeat(1000), "[" + "0,".repeat(3000) + "0]"])(
    "keeps bounded-tree fallback literal and complete",
    (source) => {
      const body = renderJson(source);
      expect(body.querySelector(".code-block-json-tree")).toBeNull();
      expect(body.querySelector("pre code")?.textContent).toBe(source);
      expect(
        readMarkdownCodeBlockCopyText(body.querySelector<HTMLElement>(".code-block-copy")!),
      ).toBe(source);
    },
  );

  it.each([" ".repeat(20_000) + "{}", '{"text":"**literal** ' + "x".repeat(20_000) + '"}'])(
    "keeps over-budget JSON-shaped source literal without constructing a tree",
    (source) => {
      const body = renderJson(source);
      expect(body.querySelector(".code-block-json-tree, strong")).toBeNull();
      expect(body.querySelector("pre code")?.textContent).toBe(source);
      expect(
        readMarkdownCodeBlockCopyText(body.querySelector<HTMLElement>(".code-block-copy")!),
      ).toBe(source);
    },
  );

  it("leaves inputs above the shared parsing limit to the existing literal-text renderer", () => {
    const source = '{"text":"**literal** ' + "x".repeat(40_000) + '"}';
    expect(parseMarkdownJson(source)).toBeNull();
    document.body.innerHTML = toSanitizedMarkdownHtml(source, interactive);
    expect(document.body.querySelector("strong")).toBeNull();
    expect(document.body.textContent).toBe(source);
  });

  it("does not emit inert view controls in static/user hosts", () => {
    const json = parseMarkdownJson('{"a":1}')!;
    for (const options of [{}, { codeBlockChrome: "none" as const }]) {
      document.body.innerHTML = toSanitizedJsonHtml(json, options);
      expect(document.querySelector(".code-block-json-mode")).toBeNull();
      expect(document.querySelector("pre code")?.textContent).toBe(json.text);
    }
  });

  it("waits for a closing fence before offering the tree", () => {
    const source = '```json\n{"a":1}';
    document.body.innerHTML = toStreamingMarkdownParts(source, interactive).join("");
    expect(document.querySelector(".code-block-json-tree")).toBeNull();
    document.body.innerHTML = toStreamingMarkdownParts(source + "\n```", interactive).join("");
    expect(document.querySelector(".code-block-json-tree")).not.toBeNull();
  });
});
