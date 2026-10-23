import { SESSION_TITLE_TARGET_SELECTOR } from "../components/session-progress-hovercard-target.ts";

export type MarkdownDomNode = {
  key: string | number;
  canonical: string;
  tag?: string;
  namespace?: string;
  attributes?: [string, string][];
  children: MarkdownDomNode[];
  hasMedia: boolean;
  slot?: number;
  text?: string;
  opaque: boolean;
};

export type MarkdownDomTree = {
  html: string;
  nodes: MarkdownDomNode[];
};

export type MarkdownHtmlParts = [string, string] & { tail?: MarkdownDomTree };

/** Read only sanitized DOM; descriptors retain no parsed nodes or parent pointers. */
export function readMarkdownDomNodes(
  root: ParentNode,
  options: {
    incremental: boolean;
    sessionTitles: boolean;
    slots?: Map<Node, number>;
    mediaAncestors?: Set<Node>;
  },
): MarkdownDomNode[] {
  const children = (parent: ParentNode): MarkdownDomNode[] => {
    const nodes = Array.from(parent.childNodes);
    const counts = new Map<string, number>();
    for (const node of nodes) {
      const key = node instanceof Element ? node.getAttribute("data-markdown-key") : null;
      if (key) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return nodes.map((node, index): MarkdownDomNode => {
      const key = node instanceof Element ? node.getAttribute("data-markdown-key") : null;
      const hasMedia = Boolean(options.mediaAncestors?.has(node) || options.slots?.has(node));
      const element = node instanceof Element ? node : undefined;
      const opaque = Boolean(
        element &&
        ((!options.incremental && !hasMedia) ||
          (options.sessionTitles && element.matches(SESSION_TITLE_TARGET_SELECTOR)) ||
          element.classList.contains("markdown-mermaid") ||
          element.localName.includes("-")),
      );
      return {
        key: key && counts.get(key) === 1 ? key : index,
        canonical: `${node.nodeType}:${element ? element.outerHTML : node.textContent}`,
        tag: element?.localName,
        namespace: element?.namespaceURI ?? undefined,
        attributes: element
          ? Array.from(element.attributes, ({ name, value }) => [name, value])
          : undefined,
        children: element && !opaque ? children(element) : [],
        hasMedia,
        slot: options.slots?.get(node),
        text: node instanceof Text ? node.data : undefined,
        opaque,
      };
    });
  };
  return children(root);
}
