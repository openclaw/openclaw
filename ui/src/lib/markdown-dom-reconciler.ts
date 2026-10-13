/** A renderer supplies only the lifecycle of its retained media island. */
export type MarkdownMediaRoot = {
  setConnected: (connected: boolean) => void;
  dispose: () => void;
};

export type MarkdownDomMedia = {
  prefix: string;
  render: (index: number, container: HTMLElement) => MarkdownMediaRoot | undefined;
};

type CanonicalNode = {
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
};
type Fragment = DomRange & {
  html: string;
  prefix: string;
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

function parseCanonical(html: string, prefix: string, incremental: boolean): CanonicalNode[] {
  const template = document.createElement("template");
  template.innerHTML = html;
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
    // Media cards are blocks, including inside lists and blockquotes.
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
        slot: slots.get(node),
        text: node instanceof Text ? node.data : undefined,
        opaque,
      };
    });
  };
  // Only strings and plain descriptors survive parsing. Retained parsed nodes
  // would keep obsolete trees alive through their parent pointers.
  return children(template.content);
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
      for (const token of oldTokens) {
        if (!tokens.has(token)) {
          element.classList.remove(token);
        }
      }
      for (const token of tokens) {
        if (!oldTokens.has(token)) {
          element.classList.add(token);
        }
      }
    } else if (value === undefined) {
      element.removeAttribute(name);
    } else {
      element.setAttribute(name, value);
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
  private connected = true;
  private readonly mediaSlots = new Map<
    number,
    { element: HTMLElement; root?: MarkdownMediaRoot }
  >();
  private usedSlots = new Set<number>();

  constructor(container: ParentNode) {
    this.range = createRange(container);
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    for (const slot of this.mediaSlots.values()) {
      slot.root?.setConnected(connected);
    }
  }

  /** The caller must supply sanitized HTML and a collision-free media prefix. */
  update(
    messageKey: string,
    source: string,
    [stableHtml, tailHtml]: readonly [string, string],
    media?: MarkdownDomMedia,
  ): void {
    if (this.messageKey !== messageKey) {
      this.releaseMedia();
    }
    if (
      this.messageKey !== messageKey ||
      !source.startsWith(this.source) ||
      !stableHtml.startsWith(this.stableHtml)
    ) {
      this.reset();
    }
    if (stableHtml.length > this.stableHtml.length) {
      const completed = stableHtml.slice(this.stableHtml.length);
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
        this.tail.html = tailHtml;
      } else {
        this.tail = this.createFragment(tailHtml, true);
        this.fragments.push(this.tail);
      }
    } else if (this.tail) {
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
  updateHtml(html: string, media?: MarkdownDomMedia, incremental = false): void {
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

  private createFragment(html: string, incremental: boolean): Fragment {
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
    for (const fragment of this.fragments) {
      const prefix = media?.prefix ?? "";
      // Canonical strings also memoize completed fragments without retaining a
      // detached DOM tree. Media policy still refreshes on every update.
      const canonical = `${prefix}\0${fragment.html}`;
      if (fragment.prefix !== canonical) {
        fragment.canonical = parseCanonical(fragment.html, prefix, fragment.incremental);
        fragment.prefix = canonical;
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
        clearRange(node);
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
        first.data = source.text;
      } else {
        clearRange(node);
        node.end.before(document.createTextNode(source.text));
      }
      node.element = undefined;
      node.content = undefined;
      node.tag = undefined;
      node.attributes = [];
      node.children = [];
    } else if (source.tag && !source.opaque) {
      if (!node.element || node.tag !== source.tag || node.opaque) {
        clearRange(node);
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
      clearRange(node);
      if (source.tag) {
        const template = document.createElement("template");
        template.innerHTML = source.canonical.slice(source.canonical.indexOf(":") + 1);
        node.end.before(template.content);
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
