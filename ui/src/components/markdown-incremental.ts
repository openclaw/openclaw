import type { MarkdownIt, Token } from "markdown-it";
import { readMarkdownDomNodes, type MarkdownDomTree } from "../lib/markdown-dom-tree.ts";
import type { MarkdownRenderEnv } from "./markdown-render-options.ts";

type RawNode = {
  raw: string;
  kind: number;
  shell: string;
  reusable: boolean;
  children: RawNode[];
  rendered: MarkdownDomTree;
};

// These HTML containers have neither raw-text parsing nor child-dependent
// sanitizer hooks. Links, tables, disclosures, and custom elements stay whole.
const containers = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "strong",
  "em",
  "b",
  "i",
  "del",
  "s",
  "blockquote",
  "ul",
  "ol",
  "li",
  "pre",
  "code",
  "div",
  "span",
]);
const htmlTags = new Set([...containers, "a", "br", "hr", "img", "button", "input"]);
const htmlNamespace = "http://www.w3.org/1999/xhtml";

function joinNodes(parts: MarkdownDomTree[]): MarkdownDomTree {
  const nodes = parts.flatMap((part) => part.nodes);
  const keys = nodes.map(
    (node) => node.attributes?.find(([name]) => name === "data-markdown-key")?.[1],
  );
  const counts = new Map<string, number>();
  for (const key of keys) {
    if (key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return {
    html: parts.map((part) => part.html).join(""),
    nodes: nodes.map((node, index) => {
      const key = keys[index];
      const nextKey = key && counts.get(key) === 1 ? key : index;
      return node.key === nextKey ? node : Object.assign({}, node, { key: nextKey });
    }),
  };
}

/** Per-stream, sanitized subtree checkpoints. No parsed DOM survives a call. */
export class IncrementalMarkdownSanitizer {
  private previous: RawNode[] = [];
  private previousHtml?: string;

  render(html: string, sanitizeInertRoot: (root: Element) => void): MarkdownDomTree {
    const template = document.createElement("template");
    const patched = this.patchText(html, template.content.ownerDocument, sanitizeInertRoot);
    if (patched) {
      this.previous = patched;
      this.previousHtml = html;
      return joinNodes(patched.map((node) => node.rendered));
    }
    template.innerHTML = html;
    const read = (node: Node, previous?: RawNode): RawNode => {
      const element = node instanceof Element ? node : undefined;
      const raw = element ? element.outerHTML : (node.textContent ?? "");
      if (previous?.kind === node.nodeType && previous.raw === raw) {
        return previous;
      }
      const children = Array.from(node.childNodes);
      const shell = element ? element.cloneNode(false) : undefined;
      const shellHtml = shell instanceof Element ? shell.outerHTML : "";
      const htmlOnly = element
        ? element.namespaceURI === htmlNamespace &&
          htmlTags.has(element.localName) &&
          children.every(
            (child) =>
              child.nodeType === Node.TEXT_NODE || (child instanceof Element && isHtmlTree(child)),
          )
        : node.nodeType === Node.TEXT_NODE;
      const oldRoot = previous?.rendered.nodes[0];
      let rendered: MarkdownDomTree;
      let nextChildren: RawNode[] = [];
      let reusable = false;
      if (
        element &&
        htmlOnly &&
        previous?.reusable &&
        previous.shell === shellHtml &&
        containers.has(element.localName) &&
        oldRoot?.tag === element.localName &&
        previous.rendered.nodes.length === 1 &&
        !oldRoot.opaque
      ) {
        nextChildren = children.map((child, index) => read(child, previous.children[index]));
        const content = joinNodes(nextChildren.map((child) => child.rendered));
        const close = `</${element.localName}>`;
        const nextHtml = shellHtml.slice(0, -close.length) + content.html + close;
        rendered = {
          html: nextHtml,
          nodes: [{ ...oldRoot, canonical: `1:${nextHtml}`, children: content.nodes }],
        };
        reusable = true;
      } else {
        // Keep even the temporary wrapper in the template's inert document:
        // custom elements must not upgrade before DOMPurify has checked them.
        const output = template.content.ownerDocument.createElement("div");
        output.append(node.cloneNode(true));
        sanitizeInertRoot(output);
        rendered = {
          html: output.innerHTML,
          nodes: readMarkdownDomNodes(output, { incremental: true, sessionTitles: true }),
        };
        const cleanRoot = output.firstElementChild;
        if (
          element &&
          htmlOnly &&
          containers.has(element.localName) &&
          output.childNodes.length === 1 &&
          cleanRoot
        ) {
          const cleanShell = cleanRoot.cloneNode(false);
          reusable = cleanShell instanceof Element && cleanShell.outerHTML === shellHtml;
        }
      }
      return {
        raw,
        kind: node.nodeType,
        shell: shellHtml,
        reusable,
        children: nextChildren,
        rendered,
      };
    };
    this.previous = Array.from(template.content.childNodes, (node, index) =>
      read(node, this.previous[index]),
    );
    this.previousHtml = template.innerHTML === html ? html : undefined;
    return joinNodes(this.previous.map((node) => node.rendered));
  }

  private patchText(
    html: string,
    inertDocument: Document,
    sanitizeInertRoot: (root: Element) => void,
  ): RawNode[] | undefined {
    const previousHtml = this.previousHtml;
    if (
      previousHtml === undefined ||
      previousHtml === html ||
      this.previous.map((node) => node.raw).join("") !== previousHtml
    ) {
      return undefined;
    }
    let start = 0;
    while (
      start < previousHtml.length &&
      start < html.length &&
      previousHtml[start] === html[start]
    ) {
      start++;
    }
    let end = previousHtml.length;
    let nextEnd = html.length;
    while (end > start && nextEnd > start && previousHtml[end - 1] === html[nextEnd - 1]) {
      end--;
      nextEnd--;
    }
    const replacement = html.slice(start, nextEnd);
    if (/[<>&\u00a0\r\0]/u.test(replacement)) {
      return undefined;
    }
    const patch = (node: RawNode, offset: number): RawNode | undefined => {
      if (start < offset || end > offset + node.raw.length) {
        return undefined;
      }
      const oldRoot = node.rendered.nodes[0];
      if (
        node.kind === Node.TEXT_NODE &&
        node.rendered.nodes.length === 1 &&
        oldRoot?.text === node.raw &&
        !/[<>&\u00a0\r\0]/u.test(node.raw)
      ) {
        const raw = node.raw.slice(0, start - offset) + replacement + node.raw.slice(end - offset);
        const output = inertDocument.createElement("div");
        output.textContent = raw;
        sanitizeInertRoot(output);
        const nodes = readMarkdownDomNodes(output, { incremental: true, sessionTitles: true });
        if (nodes.length !== 1 || nodes[0]?.text !== raw || output.innerHTML !== raw) {
          return undefined;
        }
        return { ...node, raw, rendered: { html: raw, nodes } };
      }
      if (!node.reusable || !oldRoot?.tag || oldRoot.opaque || node.rendered.nodes.length !== 1) {
        return undefined;
      }
      const close = `</${oldRoot.tag}>`;
      const open = node.shell.slice(0, -close.length);
      if (open + node.children.map((child) => child.raw).join("") + close !== node.raw) {
        return undefined;
      }
      let childOffset = offset + open.length;
      for (const [index, child] of node.children.entries()) {
        const updated = patch(child, childOffset);
        if (updated) {
          const children = node.children.slice();
          children[index] = updated;
          const content = joinNodes(children.map((entry) => entry.rendered));
          const nextHtml = open + content.html + close;
          return {
            ...node,
            raw: open + children.map((entry) => entry.raw).join("") + close,
            children,
            rendered: {
              html: nextHtml,
              nodes: [{ ...oldRoot, canonical: `1:${nextHtml}`, children: content.nodes }],
            },
          };
        }
        childOffset += child.raw.length;
      }
      return undefined;
    };
    let offset = 0;
    for (const [index, node] of this.previous.entries()) {
      const updated = patch(node, offset);
      if (updated) {
        const next = this.previous.slice();
        next[index] = updated;
        return next;
      }
      offset += node.raw.length;
    }
    return undefined;
  }
}

function isHtmlTree(node: Element): boolean {
  return (
    node.namespaceURI === htmlNamespace &&
    htmlTags.has(node.localName) &&
    Array.from(node.childNodes).every(
      (child) =>
        child.nodeType === Node.TEXT_NODE || (child instanceof Element && isHtmlTree(child)),
    )
  );
}

/** Retain pristine block state; unresolved inline syntax always uses native rules. */
export function incrementalMarkdownParser(parser: MarkdownIt) {
  let paragraph: Token[] | undefined;
  const checkpoint = (state: InstanceType<typeof parser.core.State>) => {
    paragraph =
      /^[A-Za-z]/u.test(state.src) &&
      !state.src.includes("\n") &&
      state.tokens.length === 3 &&
      state.tokens[0]?.type === "paragraph_open" &&
      state.tokens[1]?.type === "inline" &&
      state.tokens[2]?.type === "paragraph_close"
        ? state.tokens.map((token) =>
            Object.assign(new state.Token(token.type, token.tag, token.nesting), token),
          )
        : undefined;
  };
  parser.core.ruler.after("block", "streaming_paragraph_checkpoint", checkpoint);
  const rules = parser.core.ruler.getRules("");
  const inlineRules = rules.slice(rules.indexOf(checkpoint) + 1);
  return (source: string, env: MarkdownRenderEnv): string => {
    if (paragraph && /^[A-Za-z]/u.test(source) && !/[\r\n\0]/u.test(source)) {
      const state = new parser.core.State(source, parser, env);
      state.tokens = paragraph.map((token) =>
        Object.assign(new state.Token(token.type, token.tag, token.nesting), token, {
          children: token.type === "inline" ? [] : null,
          attrs: token.attrs?.map(([name, value]) => [name, value]) ?? null,
        }),
      );
      state.tokens[1]!.content = source.trimEnd();
      for (const rule of inlineRules) {
        rule(state);
      }
      return parser.renderer.render(state.tokens, parser.options, env);
    }
    return parser.render(source, env);
  };
}
