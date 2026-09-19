import { createLazyPromiseLoader } from "../shared/lazy-runtime.js";
import type { TaskRegistryControlRuntime } from "./task-registry-control.types.js";

export type TaskRegistryDeliveryRuntime = {
  sendMessage: (typeof import("./task-registry-delivery-runtime.js"))["sendMessage"];
  // Optional so existing test overrides that stub only sendMessage stay valid;
  // delivery treats a missing resolver as "no Control UI link".
  resolveTaskControlUiSessionUrl?: (typeof import("./task-registry-delivery-runtime.js"))["resolveTaskControlUiSessionUrl"];
};
export const TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY = Symbol.for(
  "openclaw.taskRegistry.deliveryRuntimeOverride",
);
export const TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY = Symbol.for(
  "openclaw.taskRegistry.controlRuntimeOverride",
);
export type TaskRegistryGlobalWithRuntimeOverrides = typeof globalThis & {
  [TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY]?: TaskRegistryDeliveryRuntime | null;
  [TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY]?: TaskRegistryControlRuntime | null;
};
export const deliveryRuntimeLoader = createLazyPromiseLoader(
  () => import("./task-registry-delivery-runtime.js"),
  { cacheRejections: true },
);
export const controlRuntimeLoader = createLazyPromiseLoader(
  () => import("./task-registry-control.runtime.js"),
  { cacheRejections: true },
);

export function loadTaskRegistryDeliveryRuntime() {
  // SAFETY: Task-registry test setters own the typed delivery override symbol.
  const deliveryRuntimeOverride = (globalThis as TaskRegistryGlobalWithRuntimeOverrides)[
    TASK_REGISTRY_DELIVERY_RUNTIME_OVERRIDE_KEY
  ];
  if (deliveryRuntimeOverride) {
    return Promise.resolve(deliveryRuntimeOverride);
  }
  return deliveryRuntimeLoader.load();
}

export function loadTaskRegistryControlRuntime() {
  // SAFETY: Task-registry test setters own the typed control override symbol.
  const controlRuntimeOverride = (globalThis as TaskRegistryGlobalWithRuntimeOverrides)[
    TASK_REGISTRY_CONTROL_RUNTIME_OVERRIDE_KEY
  ];
  if (controlRuntimeOverride) {
    return Promise.resolve(controlRuntimeOverride);
  }
  // Registry reads happen far more often than task cancellation, so keep the ACP/subagent
  // control graph off the default import path until a cancellation flow actually needs it.
  return controlRuntimeLoader.load();
}
