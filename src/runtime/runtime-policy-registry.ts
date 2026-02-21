import type { RuntimePolicy } from "./runtime-policy.js";

let activePolicy: RuntimePolicy | undefined;

export function registerRuntimePolicy(policy: RuntimePolicy): void {
  activePolicy = policy;
}

export function getRuntimePolicy(): RuntimePolicy | undefined {
  return activePolicy;
}

export function clearRuntimePolicy(): void {
  activePolicy = undefined;
}
