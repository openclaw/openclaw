import { insert, type JSX } from "@solidjs/web";
import { createRoot, runWithOwner } from "solid-js";

/** Shared and synchronous consumers own their root independently of the calling component. */
export function createDetachedRoot<T>(initialize: (dispose: () => void) => T): T {
  return runWithOwner(null, () => createRoot(initialize));
}

// Imperative consumers need inert artwork, not a second live Solid root.
export function renderSolidSnapshot(view: () => JSX.Element): DocumentFragment {
  return createDetachedRoot(
    // Construct the view inside this root so its disposal cannot retire a parent's children.
    (dispose) => {
      const host = document.createElement("div");
      try {
        // Static artwork must be inserted before cloning, even during a parent commit.
        insert(host, view());
        const snapshot = document.createDocumentFragment();
        for (const child of host.childNodes) {
          snapshot.append(child.cloneNode(true));
        }
        return snapshot;
      } finally {
        dispose();
      }
    },
  );
}
