import { createLazyPromiseLoader } from "../shared/lazy-runtime.js";
export const deliveryRuntimeLoader = createLazyPromiseLoader(
  () => import("./task-registry-delivery-runtime.js"),
  { cacheRejections: true },
);
export const controlRuntimeLoader = createLazyPromiseLoader(
  () => import("./task-registry-control.runtime.js"),
  { cacheRejections: true },
);
