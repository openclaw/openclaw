import { insert, registerDelegatedRoot, unregisterDelegatedRoot, type JSX } from "@solidjs/web";
import { createDetachedRoot } from "./detached-root.ts";

/** Own plugin DOM islands independently of the caller's commit and cleanup. */
export function mountSolidContent(target: HTMLElement, view: () => JSX.Element) {
  return createDetachedRoot((dispose) => {
    const start = document.createComment("plugin-content-start"),
      end = document.createComment("plugin-content-end");
    target.append(start, end);
    registerDelegatedRoot(target);
    let live = true;
    const stop = () => {
      if (!live) {
        return;
      }
      live = false;
      unregisterDelegatedRoot(target);
      dispose();
      while (start.nextSibling && start.nextSibling !== end) {
        target.removeChild(start.nextSibling);
      }
      start.remove();
      end.remove();
    };
    try {
      insert(target, view(), end);
      return stop;
    } catch (error) {
      stop();
      throw error;
    }
  });
}
