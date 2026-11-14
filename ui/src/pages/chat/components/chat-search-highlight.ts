import { listen } from "../../../lib/reactive/listener.ts";
import { phraseQueryPattern } from "../../../lib/text-match.ts";
import { subscribeTranscriptScroll } from "./chat-transcript-scroll-events.ts";

/** CSS name shared by the independent pane owners. */
const CHAT_SEARCH_HIGHLIGHT = "openclaw-chat-search";

type BlockText = { text: string; nodes: Text[]; starts: number[] };
type Viewport = Pick<DOMRect, "top" | "right" | "bottom" | "left">;
type Match = { from: number; to: number; range?: Range };
type NodeMatches = { node: Text; matches: Match[]; clip: Element | null };
type BlockHighlight = { content?: BlockText; ranges: Set<Range>; matches?: NodeMatches[] };
type PaneHighlight = {
  query: string;
  pattern: RegExp;
  blocks: Map<HTMLElement, BlockHighlight>;
  dirty: Set<HTMLElement>;
  queryChanged: boolean;
  geometryDirty: boolean;
  stopGeometry?: () => void;
  observer: MutationObserver;
  probe: Range;
  frame: number | null;
};

const panes = new Map<HTMLElement, PaneHighlight>();
// Ref ownership outlives search; derived text and ranges exist only in active panes.
const textBlocks = new Set<HTMLElement>();
let highlight: Highlight | undefined;

function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function"
    ? CSS.highlights
    : null;
}

function publish(): void {
  const registry = highlightRegistry();
  if (!registry) {
    return;
  }
  if (highlight?.size) {
    if (registry.get(CHAT_SEARCH_HIGHLIGHT) !== highlight) {
      registry.set(CHAT_SEARCH_HIGHLIGHT, highlight);
    }
  } else {
    registry.delete(CHAT_SEARCH_HIGHLIGHT);
    highlight = undefined;
  }
}

function clearRanges(block: BlockHighlight): void {
  for (const range of block.ranges) {
    highlight?.delete(range);
  }
  block.ranges.clear();
}

// Adjacent block elements need the same phrase separator as the Markdown projection.
const BLOCK_SELECTOR =
  "address, blockquote, dd, details, div, dl, dt, h1, h2, h3, h4, h5, h6, li, ol, p, pre, summary, table, td, th, tr, ul";
const IMAGE_SELECTOR = "img.markdown-inline-image, .markdown-inline-image-button";
const IMAGE_BARRIER = "￼";

function readableNode(node: Node): number {
  if (!(node instanceof Element)) {
    return NodeFilter.FILTER_ACCEPT;
  }
  if (node.matches(IMAGE_SELECTOR)) {
    return NodeFilter.FILTER_ACCEPT;
  }
  if (
    node.matches(".code-block-header, button:not(.markdown-person-reference), [aria-hidden='true']")
  ) {
    return NodeFilter.FILTER_REJECT;
  }
  return node.localName === "br" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
}

function readBlock(container: HTMLElement): BlockText {
  const walker = container.ownerDocument.createTreeWalker(
    container,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    { acceptNode: readableNode },
  );
  const nodes: Text[] = [];
  const starts: number[] = [];
  const parts: string[] = [];
  let length = 0;
  let block: Element | null | undefined;
  const append = (text: string) => {
    parts.push(text);
    length += text.length;
  };
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!(node instanceof Text)) {
      append(node instanceof Element && node.localName === "br" ? "\n" : IMAGE_BARRIER);
      continue;
    }
    const nodeBlock = node.parentElement?.closest(BLOCK_SELECTOR);
    if (block !== undefined && nodeBlock !== block) {
      append("\n");
    }
    block = nodeBlock;
    nodes.push(node);
    starts.push(length);
    append(node.data);
  }
  return { text: parts.join(""), nodes, starts };
}

function textViewportBounds(node: Text, probe: Range, viewport: Viewport): [number, number] | null {
  if (viewport.right <= viewport.left || viewport.bottom <= viewport.top) {
    return null;
  }
  const intersects = (rect: DOMRect) =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > viewport.top &&
    rect.top < viewport.bottom &&
    rect.right > viewport.left &&
    rect.left < viewport.right;
  probe.selectNodeContents(node);
  const rect = probe.getBoundingClientRect();
  if (!intersects(rect)) {
    return null;
  }
  if (
    rect.top >= viewport.top &&
    rect.bottom <= viewport.bottom &&
    rect.left >= viewport.left &&
    rect.right <= viewport.right
  ) {
    return [0, node.length];
  }
  let lo = 1;
  let hi = node.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    probe.setEnd(node, mid);
    if (intersects(probe.getBoundingClientRect())) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  const from = lo - 1;
  probe.setEnd(node, node.length);
  lo = 0;
  hi = node.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    probe.setStart(node, mid);
    if (intersects(probe.getBoundingClientRect())) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return [from, lo];
}

function matchesFor(content: BlockText, pattern: RegExp): NodeMatches[] {
  const { text, nodes, starts } = content;
  const normalized = text.normalize("NFC");
  // Normalize across inline nodes, then translate only matched boundaries back
  // to their original graphemes. Scrolling reuses the resulting node offsets.
  const segments =
    normalized === text
      ? null
      : new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)[Symbol.iterator]();
  let segment = segments?.next().value;
  let normalizedStart = 0;
  let normalizedPart = segment?.segment.normalize("NFC") ?? "";
  const sourceOffset = (position: number, end: boolean): number => {
    if (!segments) {
      return position;
    }
    while (segment && position > normalizedStart + normalizedPart.length) {
      normalizedStart += normalizedPart.length;
      segment = segments.next().value;
      normalizedPart = segment?.segment.normalize("NFC") ?? "";
    }
    if (!segment) {
      return text.length;
    }
    const offset = position - normalizedStart;
    if (offset === 0 || normalizedPart === segment.segment) {
      return segment.index + offset;
    }
    return segment.index + (offset === normalizedPart.length || end ? segment.segment.length : 0);
  };
  const matched = new Map<Text, NodeMatches>();
  let first = 0;
  for (const match of normalized.matchAll(pattern)) {
    const start = sourceOffset(match.index, false);
    const end = sourceOffset(match.index + match[0].length, true);
    while (first < nodes.length && starts[first]! + nodes[first]!.length <= start) {
      first++;
    }
    for (let index = first; index < nodes.length && starts[index]! < end; index++) {
      const node = nodes[index]!;
      const from = Math.max(start - starts[index]!, 0);
      const to = Math.min(end - starts[index]!, node.length);
      if (from >= to) {
        continue;
      }
      let entry = matched.get(node);
      if (!entry) {
        entry = {
          node,
          matches: [],
          clip: node.parentElement?.closest(".code-block-viewport") ?? null,
        };
        matched.set(node, entry);
      }
      entry.matches.push({ from, to });
    }
  }
  return [...matched.values()];
}

function refresh(root: HTMLElement, pane: PaneHighlight): void {
  pane.frame = null;
  if (panes.get(root) !== pane) {
    return;
  }
  const viewport = root.getBoundingClientRect();
  const clips = new Map<Element, Viewport>();
  const changed =
    pane.queryChanged || pane.geometryDirty ? pane.blocks.keys() : pane.dirty.values();
  for (const element of changed) {
    const block = pane.blocks.get(element);
    if (!block) {
      continue;
    }
    if (pane.queryChanged || !block.matches) {
      clearRanges(block);
      block.content ??= readBlock(element);
      block.matches = matchesFor(block.content, pane.pattern);
    }
    for (const entry of block.matches) {
      let visibleViewport: Viewport = viewport;
      if (entry.clip) {
        let clip = clips.get(entry.clip);
        if (!clip) {
          const rect = entry.clip.getBoundingClientRect();
          clip = {
            left: Math.max(viewport.left, rect.left),
            top: Math.max(viewport.top, rect.top),
            right: Math.min(viewport.right, rect.right),
            bottom: Math.min(viewport.bottom, rect.bottom),
          };
          clips.set(entry.clip, clip);
        }
        visibleViewport = clip;
      }
      const visible = textViewportBounds(entry.node, pane.probe, visibleViewport);
      for (const match of entry.matches) {
        if (visible && match.to > visible[0] && match.from < visible[1]) {
          if (!match.range) {
            match.range = entry.node.ownerDocument.createRange();
            match.range.setStart(entry.node, match.from);
            match.range.setEnd(entry.node, match.to);
            block.ranges.add(match.range);
            highlight ??= new Highlight();
            highlight.add(match.range);
          }
        } else if (match.range) {
          highlight?.delete(match.range);
          block.ranges.delete(match.range);
          match.range = undefined;
        }
      }
    }
  }
  pane.queryChanged = false;
  pane.geometryDirty = false;
  pane.dirty.clear();
  publish();
}

function schedule(root: HTMLElement, pane: PaneHighlight): void {
  if (pane.frame === null) {
    pane.frame = requestAnimationFrame(() => refresh(root, pane));
  }
}

function attach(root: HTMLElement, pane: PaneHighlight, element: HTMLElement): void {
  if (
    !element.classList.contains("chat-text") ||
    !root.contains(element) ||
    element.parentElement?.closest(".chat-text") ||
    pane.blocks.has(element)
  ) {
    return;
  }
  pane.blocks.set(element, { ranges: new Set() });
  pane.dirty.add(element);
  schedule(root, pane);
}

function detach(pane: PaneHighlight, element: HTMLElement): void {
  const block = pane.blocks.get(element);
  if (block) {
    clearRanges(block);
    pane.blocks.delete(element);
    pane.dirty.delete(element);
  }
}

function visitElements(node: Node, visit: (element: HTMLElement) => void): void {
  if (node instanceof HTMLElement) {
    visit(node);
  }
  const walker = node.ownerDocument?.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
  while (walker?.nextNode()) {
    if (walker.currentNode instanceof HTMLElement) {
      visit(walker.currentNode);
    }
  }
}

/** Adds a rendered transcript text block until its existing ref owner releases it. */
export function registerChatSearchTextBlock(element: HTMLElement): () => void {
  textBlocks.add(element);
  for (const [root, pane] of panes) {
    attach(root, pane, element);
  }
  return () => {
    textBlocks.delete(element);
    if (panes.size) {
      for (const pane of panes.values()) {
        detach(pane, element);
      }
      publish();
    }
  };
}

/** Tracks only mutations to registered text blocks while this pane is searching. */
function syncChatSearchHighlight(root: HTMLElement, query: string): void {
  if (!highlightRegistry()) {
    return;
  }
  const pattern = phraseQueryPattern(query);
  if (!pattern) {
    releaseChatSearchHighlight(root);
    return;
  }
  let pane = panes.get(root);
  if (!pane) {
    const observer = new MutationObserver((records) => {
      const current = panes.get(root);
      if (!current) {
        return;
      }
      for (const record of records) {
        current.geometryDirty = true;
        if (
          record.type === "attributes" &&
          record.attributeName !== "class" &&
          record.attributeName !== "aria-hidden"
        ) {
          continue;
        }
        let parent = record.target instanceof Element ? record.target : record.target.parentElement;
        while (parent && parent !== root) {
          const block = parent instanceof HTMLElement ? current.blocks.get(parent) : undefined;
          if (block && parent instanceof HTMLElement) {
            block.content = undefined;
            block.matches = undefined;
            current.dirty.add(parent);
            break;
          }
          parent = parent.parentElement;
        }
        for (const removed of record.removedNodes) {
          visitElements(removed, (element) => detach(current, element));
        }
        for (const added of record.addedNodes) {
          visitElements(added, (element) => {
            if (textBlocks.has(element)) {
              attach(root, current, element);
            }
          });
        }
      }
      if (current.geometryDirty || current.dirty.size) {
        schedule(root, current);
      }
      publish();
    });
    pane = {
      query,
      pattern,
      blocks: new Map(),
      dirty: new Set(),
      queryChanged: true,
      geometryDirty: true,
      observer,
      probe: root.ownerDocument.createRange(),
      frame: null,
    };
    panes.set(root, pane);
    const stopScroll = subscribeTranscriptScroll(root, (event) => {
      const current = panes.get(root);
      if (current && (event.type === "offset" || event.type === "resize")) {
        current.geometryDirty = true;
        schedule(root, current);
      }
    });
    const nestedScroll = (event: Event) => {
      const current = panes.get(root);
      if (current && event.target !== root) {
        current.geometryDirty = true;
        schedule(root, current);
      }
    };
    const stopNestedScroll = listen(root, "scroll", nestedScroll, true);
    const fontsChanged = () => {
      const current = panes.get(root);
      if (current) {
        current.geometryDirty = true;
        schedule(root, current);
      }
    };
    const stopFonts = listen(root.ownerDocument.fonts, "loadingdone", fontsChanged);
    pane.stopGeometry = () => {
      stopScroll();
      stopNestedScroll();
      stopFonts();
    };
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open", "aria-hidden"],
    });
    for (const element of textBlocks) {
      attach(root, pane, element);
    }
  } else if (pane.query === query) {
    return;
  } else {
    pane.query = query;
    pane.pattern = pattern;
    pane.queryChanged = true;
  }
  schedule(root, pane);
}

function releaseChatSearchHighlight(root: HTMLElement): void {
  const pane = panes.get(root);
  if (!pane) {
    return;
  }
  pane.observer.disconnect();
  pane.stopGeometry?.();
  if (pane.frame !== null) {
    cancelAnimationFrame(pane.frame);
  }
  for (const block of pane.blocks.values()) {
    clearRanges(block);
  }
  panes.delete(root);
  publish();
}

type TranscriptSearch = {
  readonly snapshot: Readonly<{ open: boolean; query: string }>;
  subscribe(notify: () => void): () => void;
};

export function watchChatSearchHighlight(root: HTMLElement, search: TranscriptSearch): () => void {
  const sync = () =>
    syncChatSearchHighlight(root, search.snapshot.open ? search.snapshot.query : "");
  sync();
  const unsubscribe = search.subscribe(sync);
  return () => {
    unsubscribe();
    releaseChatSearchHighlight(root);
  };
}
