import { createSharedEventObserver } from "./listener.ts";

/** Capture descendant scrollers too; native view coordinates are viewport-relative. */
export const observeDocumentScroll: (doc: Document, callback: () => void) => () => void =
  createSharedEventObserver("scroll", true);
