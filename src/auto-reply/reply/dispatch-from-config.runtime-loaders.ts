import { createLazyPromise } from "../../shared/lazy-promise.js";

export const loadRouteReplyRuntime = createLazyPromise(() => import("./route-reply.runtime.js"));
export const loadGetReplyFromConfigRuntime = createLazyPromise(
  () => import("./get-reply-from-config.runtime.js"),
);
export const loadAbortRuntime = createLazyPromise(() => import("./abort.runtime.js"));
export const loadFastApproveRuntime = createLazyPromise(() => import("./fast-approve.runtime.js"));
export const loadReplyMediaPathsRuntime = createLazyPromise(
  () => import("./reply-media-paths.runtime.js"),
);
export const loadRuntimePlugins = createLazyPromise(
  () => import("../../agents/runtime-plugins.js"),
);
export const loadPreparedModelRuntime = createLazyPromise(
  () => import("../../agents/prepared-model-runtime.js"),
);
