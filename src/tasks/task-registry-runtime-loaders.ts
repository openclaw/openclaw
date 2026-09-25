import { createLazyPromiseLoader } from "../shared/lazy-runtime.js";
export const deliveryRuntimeLoader = createLazyPromiseLoader(
  () => import("./task-registry-delivery-runtime.js"),
  { cacheRejections: true },
);
export const controlRuntimeLoader = createLazyPromiseLoader(
  () => import("./task-registry-control.runtime.js"),
  { cacheRejections: true },
);

export function loadTaskRegistryDeliveryRuntime() {
  return deliveryRuntimeLoader.load();
}

export function loadTaskRegistryControlRuntime() {
  // Registry reads happen far more often than task cancellation, so keep the ACP/subagent
  // control graph off the default import path until a cancellation flow actually needs it.
  return controlRuntimeLoader.load();
}
