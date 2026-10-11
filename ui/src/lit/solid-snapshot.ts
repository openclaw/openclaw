import { render, type JSX } from "@solidjs/web";
import { runWithOwner } from "solid-js";

// Legacy Lit consumers need inert artwork, not a second live Solid root.
export function renderSolidSnapshot(view: () => JSX.Element): DocumentFragment {
  return runWithOwner(null, () => {
    const host = document.createElement("div");
    const dispose = render(view, host);
    try {
      const snapshot = document.createDocumentFragment();
      for (const child of host.childNodes) {
        snapshot.append(child.cloneNode(true));
      }
      return snapshot;
    } finally {
      dispose();
    }
  });
}
