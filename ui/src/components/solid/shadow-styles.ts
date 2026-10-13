type Sheet = { element: HTMLStyleElement; references: number };

const roots = new WeakMap<Document | ShadowRoot, Map<string, Sheet>>();

/** Share one stylesheet per root, including document-hosted native surfaces. */
export function retainShadowStyles(root: Document | ShadowRoot, styles: readonly string[]) {
  const target = "host" in root ? root : root.head;
  const doc = target.ownerDocument;
  const sheets = roots.get(root) ?? new Map<string, Sheet>();
  roots.set(root, sheets);
  const retained = [...new Set(styles)].map((css) => {
    let sheet = sheets.get(css);
    if (!sheet) {
      const element = doc.createElement("style");
      element.setAttribute("data-openclaw-overlay-style", "");
      element.textContent = css;
      target.append(element);
      sheet = { element, references: 0 };
      sheets.set(css, sheet);
    }
    sheet.references += 1;
    return [css, sheet] as const;
  });
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    for (const [css, sheet] of retained) {
      sheet.references -= 1;
      if (sheet.references === 0) {
        sheet.element.remove();
        sheets.delete(css);
      }
    }
    if (sheets.size === 0) {
      roots.delete(root);
    }
  };
}

/** Follow a view's containing shadow root without duplicating document CSS imports. */
export function bindShadowStyles(element: HTMLElement, styles: readonly string[]) {
  let ancestors: Node[] = [];
  let root: ShadowRoot | undefined;
  let release: (() => void) | undefined;
  let disposed = false;
  const observer = new MutationObserver(sync);

  function sync() {
    if (disposed) {
      return;
    }
    const doc = element.ownerDocument;
    const view = doc.defaultView;
    const nextAncestors: Node[] = [];
    for (let node = element.parentNode; node;) {
      nextAncestors.push(node);
      node = view && node instanceof view.ShadowRoot ? node.host : node.parentNode;
    }
    // Keep the former attachment chain while detached so its reconnect can be
    // observed. Explicit view disposal releases these references immediately.
    if (!element.isConnected) {
      for (const ancestor of ancestors) {
        if (!nextAncestors.includes(ancestor)) {
          nextAncestors.push(ancestor);
        }
      }
    }
    if (
      ancestors.length !== nextAncestors.length ||
      ancestors.some((ancestor, index) => ancestor !== nextAncestors[index])
    ) {
      observer.disconnect();
      ancestors = nextAncestors;
      for (const ancestor of ancestors) {
        observer.observe(ancestor, { childList: true });
      }
    }
    const candidate = element.getRootNode();
    const nextRoot =
      element.isConnected && view && candidate instanceof view.ShadowRoot ? candidate : undefined;
    if (nextRoot === root) {
      return;
    }
    release?.();
    root = nextRoot;
    release = root ? retainShadowStyles(root, styles) : undefined;
  }

  sync();
  return {
    sync,
    dispose() {
      disposed = true;
      observer.disconnect();
      ancestors = [];
      release?.();
      release = undefined;
      root = undefined;
    },
  };
}
