import { createScanner, parseTree, type Node, type ParseError } from "jsonc-parser";
import { t } from "../i18n/index.ts";
import { registerCodeBlocksEnglish } from "../i18n/locales/en-code-blocks.ts";
import { MARKDOWN_PARSE_LIMIT } from "./markdown-render-options.ts";
import { escapeMarkdownHtml } from "./markdown-text.ts";

registerCodeBlocksEnglish();

// Keep the existing auto-JSON budget; bound recursive parser depth and generated DOM too.
const MAX_JSON_CHARS = 20_000;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_TOKENS = 4_000;

export type MarkdownJson = { text: string; root?: Node };

export function parseMarkdownJson(text: string): MarkdownJson | null {
  // Above the shared parse limit the message renderer already keeps all text literal.
  if (text.length > MARKDOWN_PARSE_LIMIT) {
    return null;
  }
  const trimmed = text.trim();
  if (!/^(?:\{[\s\S]*\}|\[[\s\S]*\])$/.test(trimmed)) {
    return null;
  }
  // Budget the original source, including surrounding whitespace. JSON-shaped
  // input above the tree budget stays Raw, never interpreted as Markdown.
  if (text.length > MAX_JSON_CHARS) {
    return { text };
  }
  // jsonc-parser preserves ordered duplicate members and offsets, but recurses.
  // Scan before parsing; oversized trees retain complete literal Raw/Copy content.
  const scanner = createScanner(text, true);
  let depth = 0;
  let tokens = 0;
  // The scanner gives whole string tokens, so braces inside strings never affect depth.
  // EOF has an empty span; no runtime import of the package's ambient const enums is needed.
  for (scanner.scan(); scanner.getTokenLength() > 0; scanner.scan()) {
    const delimiter = text[scanner.getTokenOffset()];
    if (delimiter === "{" || delimiter === "[") {
      depth += 1;
    }
    if (delimiter === "}" || delimiter === "]") {
      depth -= 1;
    }
    if (depth > MAX_JSON_DEPTH || ++tokens > MAX_JSON_TOKENS) {
      try {
        JSON.parse(text);
        return { text };
      } catch {
        return null;
      }
    }
  }
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  return root && errors.length === 0 ? { text, root } : null;
}

export function renderMarkdownJsonTree({ text, root }: MarkdownJson): string {
  if (!root) {
    return "";
  }
  const literal = (node: Node) =>
    escapeMarkdownHtml(text.slice(node.offset, node.offset + node.length));
  const renderNode = (node: Node, depth: number, prefix = "", suffix = ""): string => {
    const children = node.children ?? [];
    const type = node.type;
    const array = type === "array";
    if ((type !== "object" && !array) || children.length === 0) {
      const tone = type === "string" || type === "null" ? type : "literal";
      return `${prefix}<span class="code-block-json-value--${tone}">${literal(node)}</span>${suffix}`;
    }
    const opening = array ? "[" : "{";
    const closing = array ? "]" : "}";
    const summary = t(
      array
        ? children.length === 1
          ? "chat.codeBlock.jsonArrayItem"
          : "chat.codeBlock.jsonArrayItems"
        : "chat.codeBlock.jsonObjectKeys",
      { count: String(children.length) },
    );
    const rows = children
      .map((child, index) => {
        const property = child.type === "property";
        const key = property ? child.children?.[0] : undefined;
        const value = property ? child.children?.[1] : child;
        // Only an error-free AST reaches rendering; properties own a key and value.
        if (!value) {
          return "";
        }
        const label = key ? `<span class="code-block-json-key">${literal(key)}</span>: ` : "";
        return `<div class="code-block-json-row">${renderNode(value, depth + 1, label, index + 1 < children.length ? "," : "")}</div>`;
      })
      .join("");
    return `<details class="code-block-json-node"${depth < 2 ? " open" : ""}><summary>${prefix}<span class="code-block-json-node-opening">${opening}</span><span class="code-block-json-node-summary">${escapeMarkdownHtml(summary)}${suffix}</span></summary><div class="code-block-json-children">${rows}</div><span class="code-block-json-bracket">${closing}${suffix}</span></details>`;
  };
  return `<div class="code-block-json-tree" data-markdown-key="json-tree">${renderNode(root, 0)}</div>`;
}

export function renderMarkdownJsonModes(): string {
  return `<div class="code-block-json-modes" data-markdown-key="json-modes" role="group" aria-label="${escapeMarkdownHtml(t("chat.codeBlock.jsonView"))}">${(["tree", "raw"] as const).map((mode) => `<button type="button" class="code-block-json-mode" data-json-mode="${mode}" aria-pressed="${mode === "tree"}">${escapeMarkdownHtml(t(mode === "tree" ? "chat.codeBlock.jsonTree" : "chat.codeBlock.jsonRaw"))}</button>`).join("")}</div>`;
}
