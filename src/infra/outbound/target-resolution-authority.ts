// Host-owned lifecycle fence for deferred message-read target preparation.
import { AsyncLocalStorage } from "node:async_hooks";

export const targetResolutionAuthority = new AsyncLocalStorage<() => void>();

export function assertTargetResolutionCurrent(): void {
  targetResolutionAuthority.getStore()?.();
}
