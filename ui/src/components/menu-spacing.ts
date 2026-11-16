/** Classify custom row wrappers inside one menu, without document-wide :has() invalidation. */
export function observeMenuSpacing(root: HTMLElement): () => void {
  const isRow = (element: Element) =>
    element.classList.contains("oc-menu-item") ||
    element.classList.contains("oc-menu-item--submenu");
  const containsBoundary = (node: Node): boolean =>
    node instanceof Element &&
    (isRow(node) ||
      node.hasAttribute("data-menu-row-start") ||
      node.hasAttribute("data-menu-row-end") ||
      [...node.children].some(containsBoundary));
  let marked = new Set<Element>();
  const refresh = () => {
    const parents = new Set<Element>();
    const pending: Element[] = [root];
    while (pending.length) {
      const element = pending.pop()!;
      if (
        element.hasAttribute("data-menu-row-start") ||
        element.hasAttribute("data-menu-row-end")
      ) {
        marked.add(element);
      }
      if (isRow(element) && element.parentElement) {
        parents.add(element.parentElement);
      }
      pending.push(...element.children);
    }
    for (const parent of marked) {
      if (!parents.has(parent)) {
        parent.removeAttribute("data-menu-row-start");
        parent.removeAttribute("data-menu-row-end");
      }
    }
    for (const parent of parents) {
      parent.toggleAttribute(
        "data-menu-row-start",
        !parent.classList.contains("oc-overlay") &&
          Boolean(parent.firstElementChild?.classList.contains("oc-menu-item")),
      );
      parent.toggleAttribute(
        "data-menu-row-end",
        Boolean(parent.lastElementChild?.classList.contains("oc-menu-item")) ||
          [...parent.children].some((child) => child.classList.contains("oc-menu-item--submenu")),
      );
    }
    marked = parents;
  };
  const observer = new MutationObserver((records) => {
    // Avatar and label updates cannot change the boundaries of their containing row.
    if (
      records.some(
        ({ target, type, addedNodes, removedNodes }) =>
          target instanceof Element &&
          (marked.has(target) ||
            (type === "attributes"
              ? isRow(target) || Boolean(target.parentElement && marked.has(target.parentElement))
              : [...addedNodes, ...removedNodes].some(containsBoundary))),
      )
    ) {
      refresh();
    }
  });
  refresh();
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => {
    observer.disconnect();
    // Preserve geometry through the exit animation; the next connection reclassifies it.
    marked.clear();
  };
}
