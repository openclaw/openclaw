import { createSharedEventObserver } from "./listener.ts";

/** Share native resize delivery without changing callers' synchronous layout policy. */
export const observeWindowResize: (target: Window, callback: () => void) => () => void =
  createSharedEventObserver("resize");
