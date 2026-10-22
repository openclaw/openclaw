import { phraseQueryPattern } from "../../../lib/text-match.ts";

/** CSS name for `::highlight()`; one registry entry carries every pane's matches. */
export const CHAT_SEARCH_HIGHLIGHT = "openclaw-chat-search";

type PaneHighlight = {
  query: string;
  ranges: Range[];
  observer: MutationObserver;
  frame: number | null;
};

const panes = new Map<Element, PaneHighlight>();

// Transcript text blocks (messages, notices, typing previews) announce themselves
// from their ref, so highlighting never has to search transcript DOM for them.
const textBlocks = new Set<HTMLElement>();

/** Adds a rendered transcript text block to search highlighting until released. */
export function registerChatSearchTextBlock(element: HTMLElement): () => void {
  textBlocks.add(element);
  return () => {
    textBlocks.delete(element);
  };
}

function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function"
    ? CSS.highlights
    : null;
}

function publish(registry: HighlightRegistry): void {
  // Add ranges one by one: a short query in a large message can exceed the
  // engine's argument limit when spread into the constructor.
  const highlight = new Highlight();
  for (const pane of panes.values()) {
    for (const range of pane.ranges) {
      highlight.add(range);
    }
  }
  if (highlight.size > 0) {
    registry.set(CHAT_SEARCH_HIGHLIGHT, highlight);
  } else {
    registry.delete(CHAT_SEARCH_HIGHLIGHT);
  }
}

// Adjacent blocks render without whitespace text between them (`<summary>` then
// `<p>`); search text inserts the line break a reader sees at that boundary.
const BLOCK_SELECTOR =
  "address, blockquote, dd, details, div, dl, dt, h1, h2, h3, h4, h5, h6, li, ol, p, pre, summary, table, td, th, tr, ul";

// Inline content images render without text; like the search projection, a phrase
// must not match across them. The lightbox button wraps the image itself; link
// favicons and avatars are decoration and stay transparent.
const IMAGE_SELECTOR = "img.markdown-inline-image, .markdown-inline-image-button";
const IMAGE_BARRIER = "￼";

function readableNode(node: Node): number {
  if (!(node instanceof Element)) {
    return NodeFilter.FILTER_ACCEPT;
  }
  if (node.matches(IMAGE_SELECTOR)) {
    return NodeFilter.FILTER_ACCEPT;
  }
  // Code-block headers, control buttons and decorative labels are chrome; a mention
  // renders its visible name inside a button and stays message text.
  if (
    node.matches(".code-block-header, button:not(.markdown-person-reference), [aria-hidden='true']")
  ) {
    return NodeFilter.FILTER_REJECT;
  }
  // <br> carries a visible line break without a text node.
  return node.localName === "br" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
}

/** Ranges for each visible occurrence of `query` in rendered message text. */
export function collectChatSearchRanges(root: Node, query: string): Range[] {
  const pattern = phraseQueryPattern(query);
  const ranges: Range[] = [];
  if (!pattern) {
    return ranges;
  }
  for (const container of textBlocks) {
    if (
      !container.classList.contains("chat-text") ||
      !root.contains(container) ||
      container.parentElement?.closest(".chat-text")
    ) {
      continue;
    }
    const document = container.ownerDocument;
    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      { acceptNode: readableNode },
    );
    const nodes: Text[] = [];
    const starts: number[] = [];
    let text = "";
    let block: Element | null | undefined;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!(node instanceof Text)) {
        text += node instanceof Element && node.localName === "br" ? "\n" : IMAGE_BARRIER;
        continue;
      }
      const nodeBlock = node.parentElement?.closest(BLOCK_SELECTOR);
      if (block !== undefined && nodeBlock !== block) {
        text += "\n";
      }
      block = nodeBlock;
      nodes.push(node);
      starts.push(text.length);
      text += node.data;
    }
    // Matches may cross inline elements (`Title: <code>fix</code>`); mark only
    // the text each node contributes, never the chrome or separators between.
    let first = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      while (first < nodes.length && starts[first]! + nodes[first]!.length <= start) {
        first++;
      }
      for (let index = first; index < nodes.length && starts[index]! < end; index++) {
        const node = nodes[index]!;
        const from = Math.max(start - starts[index]!, 0);
        const to = Math.min(end - starts[index]!, node.length);
        if (from < to) {
          const range = document.createRange();
          range.setStart(node, from);
          range.setEnd(node, to);
          ranges.push(range);
        }
      }
    }
  }
  return ranges;
}

function refresh(root: Element, pane: PaneHighlight, registry: HighlightRegistry): void {
  pane.frame = null;
  pane.ranges = collectChatSearchRanges(root, pane.query);
  publish(registry);
}

/**
 * Marks matches without touching transcript DOM: rendered Markdown is owned by
 * its DOM reconciler, so wrapping text in <mark> would fight later updates.
 */
export function syncChatSearchHighlight(root: Element, query: string): void {
  const registry = highlightRegistry();
  if (!registry) {
    return;
  }
  if (!query.trim()) {
    releaseChatSearchHighlight(root);
    return;
  }
  let pane = panes.get(root);
  if (!pane) {
    const observer = new MutationObserver(() => {
      const current = panes.get(root);
      if (current && current.frame === null) {
        // Streaming and lazily rendered rows replace text after the projection settles.
        current.frame = requestAnimationFrame(() => refresh(root, current, registry));
      }
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    pane = { query, ranges: [], observer, frame: null };
    panes.set(root, pane);
  }
  pane.query = query;
  refresh(root, pane, registry);
}

function releaseChatSearchHighlight(root: Element): void {
  const pane = panes.get(root);
  const registry = highlightRegistry();
  if (!pane || !registry) {
    return;
  }
  pane.observer.disconnect();
  if (pane.frame !== null) {
    cancelAnimationFrame(pane.frame);
  }
  panes.delete(root);
  publish(registry);
}

type TranscriptSearch = {
  readonly snapshot: Readonly<{ open: boolean; query: string }>;
  subscribe(notify: () => void): () => void;
};

/** Follows the pane's search owner directly; the returned function stops marking. */
export function watchChatSearchHighlight(root: Element, search: TranscriptSearch): () => void {
  const sync = () =>
    syncChatSearchHighlight(root, search.snapshot.open ? search.snapshot.query : "");
  sync();
  const unsubscribe = search.subscribe(sync);
  return () => {
    unsubscribe();
    releaseChatSearchHighlight(root);
  };
}
