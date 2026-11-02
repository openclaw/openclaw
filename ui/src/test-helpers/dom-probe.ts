/** Read live DOM facts without retaining nodes across a render. */
export function domProbe(root: Pick<ParentNode, "querySelector" | "querySelectorAll">) {
  const query = root.querySelector.bind(root);
  const all = root.querySelectorAll.bind(root);
  return {
    query,
    all,
    text: (selector: string) => query(selector)?.textContent,
    attr: (selector: string, name: string) => query(selector)?.getAttribute(name),
    present: (...selectors: string[]) => selectors.map((selector) => query(selector) !== null),
  };
}

export function allMutationObserverOptions() {
  return {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  };
}

export function findButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${label} button`);
  }
  return button;
}
