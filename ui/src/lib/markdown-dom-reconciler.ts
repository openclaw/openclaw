import { SESSION_TITLE_TARGET_SELECTOR } from "../components/session-progress-hovercard-target.ts";
import { markdownContentHtml, type MarkdownContent } from "./markdown-content.ts";

/** A renderer supplies only the lifecycle of its retained media island. */
export type MarkdownMediaRoot = {
  setConnected: (connected: boolean) => void;
  dispose: () => void;
};

export type MarkdownDomMedia = {
  prefix: string;
  render: (index: number, container: HTMLElement) => MarkdownMediaRoot | undefined;
};

type MarkdownSessionTitleRegistration = (target: HTMLElement, label: HTMLElement) => () => void;

type CanonicalNode = {
  prepared?: Node;
  key: string | number;
  canonical: string;
  tag?: string;
  namespace?: string;
  attributes?: [string, string][];
  children: CanonicalNode[];
  hasMedia: boolean;
  slot?: number;
  text?: string;
  opaque: boolean;
};

type DomRange = { start: Comment; end: Comment };
type RenderedNode = DomRange & {
  key: string | number;
  canonical?: string;
  tag?: string;
  attributes: [string, string][];
  children: RenderedNode[];
  element?: Element;
  content?: DomRange;
  opaque: boolean;
  releaseSessionTitles?: () => void;
};
type Fragment = DomRange & {
  html: MarkdownContent;
  prefix: string;
  parsedHtml?: MarkdownContent;
  incremental: boolean;
  canonical: CanonicalNode[];
  children: RenderedNode[];
};

function createRange(parent: ParentNode, before: Node | null = null): DomRange {
  const start = document.createComment("");
  const end = document.createComment("");
  parent.insertBefore(start, before);
  parent.insertBefore(end, before);
  return { start, end };
}

function clearRange(range: DomRange): void {
  for (let node = range.start.nextSibling; node && node !== range.end;) {
    const next = node.nextSibling;
    node.remove();
    node = next;
  }
}

function removeRange(range: DomRange): void {
  clearRange(range);
  range.start.remove();
  range.end.remove();
}

function moveRange(range: DomRange, before: Node): void {
  if (range.start === before) {
    return;
  }
  const fragment = document.createDocumentFragment();
  for (let node: Node | null = range.start; node;) {
    const next: Node | null = node.nextSibling;
    fragment.append(node);
    if (node === range.end) {
      break;
    }
    node = next;
  }
  before.parentNode!.insertBefore(fragment, before);
}

function hasParagraphContent(node: Node): boolean {
  return Array.from(node.childNodes).some((child) =>
    child.nodeType === Node.TEXT_NODE ? child.textContent?.trim() : child.nodeName !== "BR",
  );
}

function parseCanonical(
  html: MarkdownContent,
  prefix: string,
  incremental: boolean,
  sessionTitles: boolean,
): CanonicalNode[] {
  const template = document.createElement("template");
  const prepared = typeof html !== "string";
  if (prepared) {
    template.content.append(html.fragment.cloneNode(true));
  } else {
    template.innerHTML = html;
  }
  const slots = new Map<Node, number>();
  const mediaAncestors = new Set<Node>();
  if (prefix) {
    const marker = new RegExp(`${prefix}(\\d+)END`, "g");
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node instanceof Text && node.data.includes(prefix)) {
        texts.push(node);
      }
    }
    for (const node of texts) {
      const fragment = document.createDocumentFragment();
      let offset = 0;
      for (const match of node.data.matchAll(marker)) {
        fragment.append(node.data.slice(offset, match.index));
        const slot = document.createComment(match[0]);
        slots.set(slot, Number(match[1]));
        fragment.append(slot);
        offset = match.index + match[0].length;
      }
      fragment.append(node.data.slice(offset));
      node.replaceWith(fragment);
    }
    // Within this parsed Markdown island, media cards are blocks even inside lists and quotes.
    for (const slot of slots.keys()) {
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
    for (const slot of slots.keys()) {
      for (let parent = slot.parentNode; parent; parent = parent.parentNode) {
        mediaAncestors.add(parent);
      }
    }
  }

  const children = (parent: ParentNode): CanonicalNode[] => {
    const nodes = Array.from(parent.childNodes);
    const counts = new Map<string, number>();
    for (const node of nodes) {
      const key = node instanceof Element ? node.getAttribute("data-markdown-key") : null;
      if (key) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return nodes.map((node, index): CanonicalNode => {
      const key = node instanceof Element ? node.getAttribute("data-markdown-key") : null;
      const hasMedia = mediaAncestors.has(node) || slots.has(node);
      const element = node instanceof Element ? node : undefined;
      const opaque = Boolean(
        element &&
        ((!incremental && !hasMedia) ||
          (sessionTitles && element.matches(SESSION_TITLE_TARGET_SELECTOR)) ||
          element.classList.contains("markdown-mermaid") ||
          element.localName.includes("-")),
      );
      return {
        prepared: prepared && opaque ? node.cloneNode(true) : undefined,
        key: key && counts.get(key) === 1 ? key : index,
        canonical: `${node.nodeType}:${element ? element.outerHTML : node.textContent}`,
        tag: element?.localName,
        namespace: element?.namespaceURI ?? undefined,
        attributes: element
          ? Array.from(element.attributes, ({ name, value }) => [name, value])
          : undefined,
        children: element && !opaque ? children(element) : [],
        hasMedia,
        slot: slots.get(node),
        text: node instanceof Text ? node.data : undefined,
        opaque,
      };
    });
  };
  // Opaque prepared nodes are detached clones: descriptors must not retain the
  // parsed tree through parent pointers after its content has been replaced.
  return children(template.content);
}

function releaseSessionTitles(node: {
  children: RenderedNode[];
  releaseSessionTitles?: () => void;
}): void {
  node.releaseSessionTitles?.();
  node.releaseSessionTitles = undefined;
  for (const child of node.children) {
    releaseSessionTitles(child);
  }
}

function clearRenderedRange(node: RenderedNode): void {
  releaseSessionTitles(node);
  clearRange(node);
}

function patchAttributes(
  element: Element,
  before: [string, string][],
  after: [string, string][],
): void {
  const previous = new Map(before);
  const next = new Map(after);
  for (const name of new Set([...previous.keys(), ...next.keys()])) {
    const oldValue = previous.get(name);
    const value = next.get(name);
    if (oldValue === value) {
      continue;
    }
    if (name === "class") {
      const oldTokens = new Set(oldValue?.split(/\s+/).filter(Boolean));
      const tokens = new Set(value?.split(/\s+/).filter(Boolean));
      // Canonical tokens keep their serialized order; reader-owned state survives.
      const retained = [...element.classList].filter(
        (token) => !oldTokens.has(token) && !tokens.has(token),
      );
      const classes = [...tokens, ...retained].join(" ");
      if (value === undefined && !classes) {
        element.removeAttribute(name);
      } else {
        element.setAttribute(name, classes);
      }
    } else if (value === undefined) {
      element.removeAttribute(name);
    } else {
      element.setAttribute(name, value);
    }
  }
  // An attribute added midway through a stream must take its one-shot position.
  if (before.map(([name]) => name).join("\0") !== after.map(([name]) => name).join("\0")) {
    const ordered = after.map(([name]) => [name, element.getAttribute(name)] as const);
    for (const [name] of ordered) {
      element.removeAttribute(name);
    }
    for (const [name, value] of ordered) {
      if (value !== null) {
        element.setAttribute(name, value);
      }
    }
  }
}

/** Owns sanitized Markdown DOM, independently of the framework driving updates. */
export class MarkdownDomReconciler {
  private readonly range: DomRange;
  private fragments: Fragment[] = [];
  private tail?: Fragment;
  private messageKey?: string;
  private source = "";
  private stableHtml = "";
  private previewText?: { node: Text; original: string; path: RenderedNode[] };
  private connected = true;
  private readonly mediaSlots = new Map<
    number,
    { element: HTMLElement; root?: MarkdownMediaRoot }
  >();
  private usedSlots = new Set<number>();

  constructor(
    container: ParentNode,
    private readonly registerSessionTitle?: MarkdownSessionTitleRegistration,
  ) {
    this.range = createRange(container);
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    for (const slot of this.mediaSlots.values()) {
      slot.root?.setConnected(connected);
    }
  }

  canPreview(messageKey: string, source: string): boolean {
    if (
      messageKey !== this.messageKey ||
      source.length <= this.source.length ||
      !source.startsWith(this.source) ||
      !this.tail
    ) {
      return false;
    }
    // Keep inline delimiters canonical: transient syntax can wrap, then shrink again.
    if (
      /[\n\r<>&`*_~[\]()!\\|]/u.test(source.slice(this.source.length)) ||
      /[\uE000-\uF8FF]/u.test(source)
    ) {
      return false;
    }
    if (this.previewText) {
      return true;
    }
    const preview = this.findPreviewText(this.tail.children);
    // A closed emphasis/link/code leaf cannot own text following its closing delimiter.
    return Boolean(preview && this.source.endsWith(preview.node.data));
  }

  private findPreviewPath(nodes: RenderedNode[]): RenderedNode[] | undefined {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i]!;
      const nested = this.findPreviewPath(node.children);
      if (nested) {
        return [node, ...nested];
      }
      if (
        node.canonical?.startsWith("3:") &&
        node.start.parentElement?.closest("p,li,code,td,th,h1,h2,h3,h4,h5,h6")
      ) {
        return [node];
      }
    }
    return undefined;
  }

  private findPreviewText(nodes: RenderedNode[]) {
    const path = this.findPreviewPath(nodes);
    const range = path?.at(-1);
    const text = range?.start.nextSibling;
    return text instanceof Text && text.nextSibling === range?.end
      ? { node: text, path: path! }
      : undefined;
  }

  /** Show safe text now; formatting still owns the canonical tree and the next update. */
  preview(source: string): void {
    if (!this.previewText) {
      const preview = this.findPreviewText(this.tail!.children)!;
      this.previewText = { ...preview, original: preview.node.data };
    }
    const text = this.previewText.original + source.slice(this.source.length);
    if (this.previewText.node.data !== text) {
      this.previewText.node.data = text;
    }
  }

  private clearPreview(): void {
    if (this.previewText) {
      // Reconcile from the visible text, without dirtying layout by restoring old bytes first.
      for (const node of this.previewText.path) {
        node.canonical = undefined;
      }
      this.tail!.parsedHtml = undefined;
      this.previewText = undefined;
    }
  }

  /** The caller must supply sanitized HTML and a collision-free media prefix. */
  update(
    messageKey: string,
    source: string,
    [stableContent, tailContent]: readonly [MarkdownContent, MarkdownContent],
    media?: MarkdownDomMedia,
  ): void {
    this.clearPreview();
    const stableHtml = markdownContentHtml(stableContent);
    const tailHtml = markdownContentHtml(tailContent);
    if (this.messageKey !== messageKey) {
      this.releaseMedia();
    }
    if (
      this.messageKey !== messageKey ||
      !source.startsWith(this.source) ||
      (stableHtml !== this.stableHtml && !stableHtml.startsWith(this.stableHtml))
    ) {
      this.reset();
    }
    if (stableHtml.length > this.stableHtml.length) {
      const completed = this.stableHtml ? stableHtml.slice(this.stableHtml.length) : stableContent;
      if (this.tail) {
        // Promotion retains the same DOM owner and its reader state.
        this.tail.html = completed;
        this.tail = undefined;
      } else {
        this.fragments.push(this.createFragment(completed, false));
      }
    }
    if (tailHtml) {
      if (this.tail) {
        this.tail.html = tailContent;
      } else {
        this.tail = this.createFragment(tailContent, true);
        this.fragments.push(this.tail);
      }
    } else if (this.tail) {
      releaseSessionTitles(this.tail);
      removeRange(this.tail);
      this.fragments.pop();
      this.tail = undefined;
    }
    this.messageKey = messageKey;
    this.source = source;
    this.stableHtml = stableHtml;
    this.renderFragments(media);
  }

  /** A standalone fragment uses the same canonical-tree and media ownership. */
  updateHtml(html: MarkdownContent, media?: MarkdownDomMedia, incremental = false): void {
    this.clearPreview();
    let fragment = this.fragments[0];
    if (!fragment || fragment.incremental !== incremental) {
      this.reset();
      fragment = this.createFragment(html, incremental);
      this.fragments.push(fragment);
    }
    fragment.html = html;
    this.renderFragments(media);
  }

  dispose(): void {
    this.releaseMedia();
    this.reset();
    removeRange(this.range);
  }

  private reset(): void {
    this.clearPreview();
    for (const fragment of this.fragments) {
      releaseSessionTitles(fragment);
    }
    clearRange(this.range);
    this.fragments = [];
    this.tail = undefined;
    this.stableHtml = "";
  }

  private releaseMedia(): void {
    for (const slot of this.mediaSlots.values()) {
      slot.root?.dispose();
    }
    this.mediaSlots.clear();
  }

  private createFragment(html: MarkdownContent, incremental: boolean): Fragment {
    return {
      ...createRange(this.range.end.parentNode!, this.range.end),
      html,
      prefix: "",
      incremental,
      canonical: [],
      children: [],
    };
  }

  private renderFragments(media?: MarkdownDomMedia): void {
    this.usedSlots = new Set();
    const prefix = media?.prefix ?? "";
    for (const fragment of this.fragments) {
      // Retain the inputs separately so completed fragments need no combined key.
      // Media policy still refreshes on every update.
      if (fragment.prefix !== prefix || fragment.parsedHtml !== fragment.html) {
        fragment.canonical = parseCanonical(
          fragment.html,
          prefix,
          fragment.incremental,
          Boolean(this.registerSessionTitle),
        );
        fragment.prefix = prefix;
        fragment.parsedHtml = fragment.html;
      } else if (!media) {
        continue;
      }
      fragment.children = this.reconcile(fragment, fragment.children, fragment.canonical, media);
    }
    for (const [index, slot] of this.mediaSlots) {
      if (!this.usedSlots.has(index)) {
        slot.root?.dispose();
        this.mediaSlots.delete(index);
      }
    }
  }

  private reconcile(
    range: DomRange,
    previous: RenderedNode[],
    canonical: CanonicalNode[],
    media?: MarkdownDomMedia,
  ): RenderedNode[] {
    const remaining = new Map(previous.map((node) => [node.key, node]));
    let cursor = range.start.nextSibling!;
    const next = canonical.map((source) => {
      const node = remaining.get(source.key) ?? {
        ...createRange(range.end.parentNode!, range.end),
        key: source.key,
        attributes: [],
        children: [],
        opaque: false,
      };
      remaining.delete(source.key);
      if (cursor === range.end && node.start.nextSibling === node.end) {
        cursor = node.start;
      }
      moveRange(node, cursor);
      this.updateNode(node, source, media);
      cursor = node.end.nextSibling!;
      return node;
    });
    for (const node of remaining.values()) {
      releaseSessionTitles(node);
      removeRange(node);
    }
    return next;
  }

  private updateNode(node: RenderedNode, source: CanonicalNode, media?: MarkdownDomMedia): void {
    if (source.slot !== undefined) {
      const index = source.slot;
      let slot = this.mediaSlots.get(index);
      if (!slot) {
        slot = { element: document.createElement("div") };
        this.mediaSlots.set(index, slot);
      }
      const root = media?.render(index, slot.element);
      if (root) {
        slot.root = root;
        root.setConnected(this.connected);
        this.usedSlots.add(index);
      }
      if (node.start.nextSibling !== slot.element || !root) {
        clearRenderedRange(node);
        if (root) {
          node.end.before(slot.element);
        }
      }
      node.canonical = undefined;
      node.element = undefined;
      node.content = undefined;
      node.children = [];
      node.attributes = [];
      node.tag = undefined;
      return;
    }
    if (node.canonical === source.canonical && !source.hasMedia) {
      return;
    }
    if (source.text !== undefined) {
      const first = node.start.nextSibling;
      // External highlighters can split or wrap text; repair only this range.
      if (first instanceof Text && first.nextSibling === node.end) {
        if (first.data !== source.text) {
          first.data = source.text;
        }
      } else {
        clearRenderedRange(node);
        node.end.before(document.createTextNode(source.text));
      }
      node.element = undefined;
      node.content = undefined;
      node.tag = undefined;
      node.attributes = [];
      node.children = [];
    } else if (source.tag && !source.opaque) {
      if (!node.element || node.tag !== source.tag || node.opaque) {
        clearRenderedRange(node);
        node.element = document.createElementNS(source.namespace ?? null, source.tag);
        node.end.before(node.element);
        node.attributes = [];
        node.children = [];
        node.content = createRange(node.element);
      }
      patchAttributes(node.element, node.attributes, source.attributes!);
      node.attributes = source.attributes!;
      node.children = this.reconcile(node.content!, node.children, source.children, media);
      node.tag = source.tag;
    } else {
      clearRenderedRange(node);
      if (source.tag) {
        const template = document.createElement("template");
        // Serializing parsed HTML restores literal CRs; encode them before another parse.
        if (source.prepared) {
          template.content.append(source.prepared.cloneNode(true));
        } else {
          template.innerHTML = source.canonical
            .slice(source.canonical.indexOf(":") + 1)
            .replaceAll("\r", "&#13;");
        }
        const registerSessionTitle = this.registerSessionTitle;
        const targets = registerSessionTitle
          ? [...template.content.querySelectorAll<HTMLElement>(SESSION_TITLE_TARGET_SELECTOR)]
          : [];
        node.end.before(template.content);
        if (registerSessionTitle && targets.length) {
          const releases = targets.map((target) =>
            registerSessionTitle(target, document.createElement("span")),
          );
          node.releaseSessionTitles = () => releases.forEach((release) => release());
        }
      }
      node.element = undefined;
      node.content = undefined;
      node.children = [];
      node.attributes = [];
      node.tag = source.tag;
    }
    node.opaque = source.opaque;
    node.canonical = source.canonical;
  }
}
