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

/** Refresh shadow styles when the owning view connects or updates. */
export function bindShadowStyles(element: HTMLElement, styles: readonly string[]) {
  let root: ShadowRoot | undefined;
  let release: (() => void) | undefined;

  function sync() {
    const view = element.ownerDocument.defaultView;
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
      release?.();
      release = undefined;
      root = undefined;
    },
  };
}
