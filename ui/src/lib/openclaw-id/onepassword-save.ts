import { activateOPButton } from "@1password/save-button";
import { encodeOnePasswordKit } from "./onepassword-payload.js";

/** Mounts the official login save button for one kit; never confirms that the owner saved it. */
export function mountOnePasswordKit(
  host: HTMLElement,
  payload: { title: string; username: string; code: string; notes: string; url: string },
  onEnabled: (enabled: boolean) => void,
): () => void {
  // Set the complete payload before connection: the vendor renders its shadow DOM once.
  const element = document.createElement("onepassword-save-button");
  const value = encodeOnePasswordKit(payload);
  element.setAttribute("data-onepassword-type", "login");
  if (!value) {
    throw new Error("1Password kit encoding failed");
  }
  element.setAttribute("value", value);
  element.setAttribute("padding", "none");
  element.setAttribute("lang", document.documentElement.lang || "en");
  element.setAttribute("data-theme", document.documentElement.dataset.themeMode || "light");
  host.append(element);

  // This is vendor-owned DOM. Only the extension enables its native save button.
  const observer = new MutationObserver((records) => {
    for (const { target } of records) {
      if (
        target instanceof HTMLButtonElement &&
        target.hasAttribute("data-onepassword-save-button")
      ) {
        onEnabled(!target.disabled);
      }
    }
  });
  if (element.shadowRoot) {
    observer.observe(element.shadowRoot, {
      attributes: true,
      attributeFilter: ["disabled"],
      subtree: true,
    });
  }
  activateOPButton();
  onEnabled(false);

  return () => {
    observer.disconnect();
    // v1.3.0 retains two global listeners per mount. They cannot be removed through
    // its public API; scrub both payload copies in the retained element and subtree.
    element.removeAttribute("value");
    // The shadow DOM is vendor-owned. Clear value-bearing nodes before detaching;
    // the vendor's body listener retains the element, not our payload or observer.
    const root = element.shadowRoot;
    if (root) {
      const nodes = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
        if (node instanceof HTMLButtonElement) {
          node.value = "";
          node.removeAttribute("value");
          node.disabled = true;
        }
      }
      // Keep the scrubbed vendor structure: late extension replies still address it.
    }
    element.remove();
  };
}
