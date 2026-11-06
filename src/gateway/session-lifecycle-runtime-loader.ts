import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

/** Lazily loads the session lifecycle runtime to preserve the Gateway startup boundary. */
export const loadSessionLifecycleRuntime = createLazyRuntimeModule(
  () => import("./server-methods/sessions.runtime.js"),
);
