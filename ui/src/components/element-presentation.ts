/** Observe only the active trigger's rendered ancestry, including slots and shadow roots. */
export function createElementPresentationObserver(
  target: () => Element | null,
  onHidden: () => void,
  extraAttributes: readonly string[] = [],
) {
  let observed: Node[] = [];
  const ancestors = () => {
    const nodes: Node[] = [];
    let node: Node | null = target();
    while (node) {
      nodes.push(node);
      node =
        node instanceof Element && node.assignedSlot
          ? node.assignedSlot
          : node instanceof ShadowRoot
            ? node.host
            : node.parentNode;
    }
    return nodes;
  };
  const isPresented = () =>
    target()?.isConnected === true &&
    !ancestors().some(
      (node) =>
        node instanceof Element &&
        (node.hasAttribute("hidden") ||
          node.hasAttribute("inert") ||
          node.getAttribute("aria-hidden") === "true"),
    );
  const observer = new MutationObserver(() => {
    if (isPresented()) {
      observe();
    } else {
      onHidden();
    }
  });
  function observe() {
    const next = ancestors();
    if (next.length === observed.length && next.every((node, index) => node === observed[index])) {
      return;
    }
    observer.disconnect();
    observed = next;
    for (const node of next) {
      observer.observe(node, {
        childList: true,
        attributes: true,
        attributeFilter: ["hidden", "inert", "aria-hidden", ...extraAttributes],
      });
    }
  }
  return {
    isPresented,
    observe,
    disconnect() {
      observer.disconnect();
      observed = [];
    },
  };
}
