import { insert, type JSX } from "@solidjs/web";
import { createRoot, runWithOwner } from "solid-js";

// Legacy Lit consumers need inert artwork, not a second live Solid root.
export function renderSolidSnapshot(view: () => JSX.Element): DocumentFragment {
  return runWithOwner(null, () =>
    createRoot((dispose) => {
      const host = document.createElement("div");
      try {
        insert(host, view());
        const snapshot = document.createDocumentFragment();
        for (const child of host.childNodes) {
          snapshot.append(child.cloneNode(true));
        }
        return snapshot;
      } finally {
        dispose();
      }
    }),
  );
}
