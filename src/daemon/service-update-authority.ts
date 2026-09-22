import { AsyncLocalStorage } from "node:async_hooks";

export const GATEWAY_UPDATE_EXECUTOR_CONTRACT = "root-spawner-v1";

const owners = new AsyncLocalStorage<() => void>();

/** The target CLI installs this only after binding its original update grant.
 * It remains in inherited async work after closure, where assertions must fail. */
export async function withGatewayServiceUpdateAuthority<T>(
  assertOwner: () => void,
  operation: () => Promise<T>,
): Promise<T> {
  let active = true;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Update-owned native command has closed.");
    }
    assertOwner();
  };
  assertCurrent();
  try {
    return await owners.run(assertCurrent, async () => {
      const result = await operation();
      assertCurrent();
      return result;
    });
  } finally {
    active = false;
  }
}

/** Ordinary user service commands have no update owner and retain their behavior. */
export function assertGatewayServiceUpdateCurrent(): void {
  owners.getStore()?.();
}

export function isUpdateOwnedGatewayServiceCommand(): boolean {
  return owners.getStore() !== undefined;
}

/** Detached or unmanaged fallbacks cannot retain the updater grant. */
export function assertGatewayServiceFallbackAllowed(action: string): void {
  if (owners.getStore()) {
    throw new Error(`UPDATE_NATIVE_AUTHORITY: ${action} is not an update-owned native operation.`);
  }
}
