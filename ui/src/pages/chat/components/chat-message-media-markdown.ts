import { noChange, nothing, type ChildPart, type ElementPart } from "lit";
import { getCommittedValue, setCommittedValue } from "lit/directive-helpers.js";
import { Directive, directive } from "lit/directive.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { html, unsafeStatic } from "lit/static-html.js";
import type { ProjectedMessageContent } from "./chat-message-media.ts";

type PositionedMedia = Exclude<ProjectedMessageContent, { type: "text" }>;
export type MarkdownMedia = {
  prefix: string;
  text: string;
  items: PositionedMedia[];
  render: (item: PositionedMedia, index: number) => unknown;
};

export function prepareMarkdownMedia(
  content: readonly ProjectedMessageContent[],
  render: MarkdownMedia["render"],
): { markdown: string; media: MarkdownMedia } {
  const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
  let prefix = "OPENCLAWMEDIASLOT";
  while (text.includes(prefix)) {
    prefix += "X";
  }
  const items: PositionedMedia[] = [];
  const markdown = content
    .map((item) => {
      if (item.type === "text") {
        return item.text;
      }
      items.push(item);
      return `${prefix}${items.length - 1}END`;
    })
    .join("\n");
  return { markdown, media: { prefix, text, items, render } };
}

function hasParagraphContent(node: Node): boolean {
  return Array.from(node.childNodes).some((child) =>
    child.nodeType === Node.TEXT_NODE ? child.textContent?.trim() : child.nodeName !== "BR",
  );
}

class MarkdownAttributesDirective extends Directive {
  private previous = new Map<string, string>();

  render(_source: Element) {
    return noChange;
  }

  override update(part: ElementPart, [source]: [Element]) {
    const next = new Map(Array.from(source.attributes, (attr) => [attr.name, attr.value]));
    for (const name of new Set([...this.previous.keys(), ...next.keys()])) {
      const before = this.previous.get(name);
      const after = next.get(name);
      if (before === after) {
        continue;
      }
      if (name === "class") {
        // Canonical class changes must not erase reader-owned wrap/expand state.
        const oldTokens = new Set(before?.split(/\s+/).filter(Boolean));
        const newTokens = new Set(after?.split(/\s+/).filter(Boolean));
        for (const token of oldTokens) {
          if (!newTokens.has(token)) {
            part.element.classList.remove(token);
          }
        }
        for (const token of newTokens) {
          if (!oldTokens.has(token)) {
            part.element.classList.add(token);
          }
        }
      } else if (after === undefined) {
        part.element.removeAttribute(name);
      } else {
        part.element.setAttribute(name, after);
      }
    }
    this.previous = next;
    return noChange;
  }
}

const markdownAttributes = directive(MarkdownAttributesDirective);
const voidTags = new Set(["br", "hr", "img", "input"]);
type MarkdownBindings = {
  media?: MarkdownMedia;
  slots: Map<Node, number>;
  mediaAncestors: Set<Node>;
  incremental: boolean;
};

class MarkdownNodeDirective extends Directive {
  private previous?: string;

  override update(part: ChildPart, [node, bindings]: [Node, MarkdownBindings]) {
    const value = this.render(node, bindings);
    if (typeof value === "string" && typeof getCommittedValue(part) === "string") {
      const first = part.startNode?.nextSibling;
      // Highlighters can wrap or split a Text node. Lit's text fast path assumes
      // one intact node; rebuild only this text range when that contract changed.
      if (!(first instanceof Text) || first.nextSibling !== part.endNode) {
        setCommittedValue(part);
      }
    }
    return value;
  }

  render(node: Node, bindings: MarkdownBindings): unknown {
    const slot = bindings.slots.get(node);
    if (slot !== undefined) {
      this.previous = undefined;
      const item = bindings.media?.items[slot];
      return item ? bindings.media?.render(item, slot) : nothing;
    }
    const canonical = `${node.nodeType}:${node instanceof Element ? node.outerHTML : node.textContent}`;
    const unchanged = this.previous === canonical;
    // Do not retain canonical Nodes: their parent pointers would keep entire
    // obsolete parse trees alive when unchanged descendants skip rendering.
    this.previous = canonical;
    // Compare detached canonical trees, never the live DOM enhanced by controls
    // or highlighters. Media bindings still run on every render to refresh policy.
    if (unchanged && !bindings.mediaAncestors.has(node)) {
      return noChange;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }
    if (!(node instanceof Element)) {
      return nothing;
    }
    // Completed subtrees need no per-node bindings. Mermaid and custom elements
    // own their children: their enhancements can remove Lit's child markers.
    if (
      (!bindings.incremental && !bindings.mediaAncestors.has(node)) ||
      node.classList.contains("markdown-mermaid") ||
      node.localName.includes("-")
    ) {
      return unsafeHTML(node.outerHTML);
    }
    // Only sanitizer-allowlisted tag names enter Lit's static template cache.
    // Text and attributes stay dynamic, avoiding one cached template per token.
    const tag = unsafeStatic(node.localName);
    return voidTags.has(node.localName)
      ? html`<${tag} ${markdownAttributes(node)}>`
      : html`<${tag} ${markdownAttributes(node)}>${renderMarkdownChildren(node, bindings)}</${tag}>`;
  }
}

const markdownNode = directive(MarkdownNodeDirective);

function renderMarkdownChildren(parent: ParentNode, bindings: MarkdownBindings) {
  const children = Array.from(parent.childNodes, (node) => ({
    node,
    key: node instanceof Element ? node.getAttribute("data-markdown-key") : null,
  }));
  const counts = new Map<string, number>();
  for (const { key } of children) {
    if (key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  // Producer keys keep controls with their operation/state when siblings appear.
  // Sanitized authored HTML can carry data-* too: ambiguous keys stay positional
  // (numeric), never colliding with unique string keys or dropping siblings.
  return repeat(
    children,
    ({ key }, index) => (key && counts.get(key) === 1 ? key : index),
    ({ node }) => markdownNode(node, bindings),
  );
}

class MarkdownMediaDirective extends Directive {
  private source = "";
  private prefix = "";
  private template?: HTMLTemplateElement;
  private slots = new Map<Node, number>();
  private mediaAncestors = new Set<Node>();

  render(sanitizedHtml: string, media?: MarkdownMedia, incremental = false) {
    if (!incremental && !media) {
      return unsafeHTML(sanitizedHtml);
    }
    const prefix = media?.prefix ?? "";
    if (this.source !== sanitizedHtml || this.prefix !== prefix || !this.template) {
      this.source = sanitizedHtml;
      this.prefix = prefix;
      const template = document.createElement("template");
      template.innerHTML = sanitizedHtml;
      this.template = template;
      this.slots.clear();
      this.mediaAncestors.clear();
      const marker = new RegExp(`${prefix}(\\d+)END`, "g");
      const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      const slots: Comment[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (prefix && node instanceof Text && node.data.includes(prefix)) {
          nodes.push(node);
        }
      }
      // Only our collision-free text markers become bindings. Never interpolate
      // attribute values or unsanitized model HTML into a Lit template.
      for (const node of nodes) {
        const fragment = document.createDocumentFragment();
        let offset = 0;
        for (const match of node.data.matchAll(marker)) {
          fragment.append(node.data.slice(offset, match.index));
          const slot = document.createComment(match[0]);
          slots.push(slot);
          this.slots.set(slot, Number(match[1]));
          fragment.append(slot);
          offset = match.index + match[0].length;
        }
        fragment.append(node.data.slice(offset));
        node.replaceWith(fragment);
      }
      // Media cards are blocks. Split their containing paragraph while retaining
      // list items, quotes, and other surrounding Markdown structure.
      for (const slot of slots) {
        const paragraph = slot.parentElement?.closest("p");
        if (!paragraph) {
          continue;
        }
        const before = paragraph.cloneNode(false);
        const range = document.createRange();
        range.setStart(paragraph, 0);
        range.setEndBefore(slot);
        before.appendChild(range.extractContents());
        if (hasParagraphContent(before)) {
          paragraph.before(before);
        }
        paragraph.before(slot);
        if (!hasParagraphContent(paragraph)) {
          paragraph.remove();
        }
      }
      for (const slot of slots) {
        for (let parent = slot.parentNode; parent; parent = parent.parentNode) {
          this.mediaAncestors.add(parent);
        }
      }
    }
    const bindings = { media, slots: this.slots, mediaAncestors: this.mediaAncestors, incremental };
    return renderMarkdownChildren(this.template.content, bindings);
  }
}

export const renderMarkdownMedia = directive(MarkdownMediaDirective);
