import { AsyncLocalStorage } from "node:async_hooks";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";

export const GATEWAY_UPDATE_EXECUTOR_CONTRACT = "root-spawner-v1";

export class GatewayServiceAuthorityError extends Error {
  readonly code = "service-authority-revoked";

  constructor(
    cause: unknown,
    readonly outcome?: "unchanged" | "restored" | "recovery-pending",
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "GatewayServiceAuthorityError";
  }
}

const owners = new AsyncLocalStorage<
  | {
      assertCurrent: () => void;
      compensate: <T>(operation: () => Promise<T>) => Promise<T>;
      updateOwned: boolean;
    }
  | undefined
>();

/** Bind the caller and every inherited update grant to this native-operation lifetime.
 * Inherited async work and retained callbacks must fail after closure. */
export async function withGatewayServiceUpdateAuthority<T>(
  assertOwner: (() => void) | undefined,
  operation: (assertCurrent: () => void) => Promise<T>,
  options?: { updateOwned?: boolean; assertRecoveryCurrent?: () => void },
): Promise<T> {
  const parent = owners.getStore();
  let active = true;
  const assertScope = (compensating = false) => {
    if (!active) {
      throw new GatewayServiceAuthorityError(new Error("Native service authority has closed."));
    }
    try {
      // Caller assertions can borrow a native lock whose checks consult this scope.
      // Evaluate them in their original context, retaining every inherited updater fence.
      owners.run(parent, () => {
        parent?.assertCurrent();
        options?.assertRecoveryCurrent?.();
        if (!compensating || !options?.assertRecoveryCurrent) {
          assertOwner?.();
        }
      });
    } catch (error) {
      throw error instanceof GatewayServiceAuthorityError
        ? error
        : new GatewayServiceAuthorityError(error);
    }
  };
  const assertCurrent = () => assertScope();
  try {
    assertCurrent();
  } catch (error) {
    throw new GatewayServiceAuthorityError(error, "unchanged");
  }
  try {
    return await owners.run(
      {
        assertCurrent,
        updateOwned: parent?.updateOwned || (options?.updateOwned ?? true),
        compensate: (restore) =>
          owners.run(parent, () =>
            withGatewayServiceUpdateAuthority(() => assertScope(true), restore),
          ),
      },
      async () => {
        try {
          const result = await operation(assertCurrent);
          assertCurrent();
          return result;
        } catch (error) {
          throw retainServiceAuthorityFailure(error);
        }
      },
    );
  } finally {
    active = false;
  }
}

/** Ordinary user service commands have no update owner and retain their behavior. */
export function assertGatewayServiceUpdateCurrent(): boolean {
  const owner = owners.getStore();
  owner?.assertCurrent();
  return owner !== undefined;
}

export function isUpdateOwnedGatewayServiceCommand(): boolean {
  return owners.getStore()?.updateOwned === true;
}

/** Detached or unmanaged fallbacks cannot retain the updater grant. */
export function assertGatewayServiceFallbackAllowed(action: string): void {
  assertGatewayServiceUpdateCurrent();
  if (isUpdateOwnedGatewayServiceCommand()) {
    throw new Error(`UPDATE_NATIVE_AUTHORITY: ${action} is not an update-owned native operation.`);
  }
}

function retainServiceAuthorityFailure(error: unknown): unknown {
  if (!(error instanceof GatewayServiceAuthorityError)) {
    try {
      assertGatewayServiceUpdateCurrent();
    } catch (cause) {
      return new GatewayServiceAuthorityError(
        new AggregateError([error, cause], cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }
  return error;
}

/** Only captured publication receipts may use this while their original lock is live. */
export async function withGatewayServiceInstallationRecovery<T>(
  install: () => Promise<T>,
  restore: () => Promise<boolean>,
): Promise<T> {
  try {
    const result = await install();
    assertGatewayServiceUpdateCurrent();
    return result;
  } catch (cause) {
    if (hasCommandProcessCleanupError(cause)) {
      throw cause;
    }
    const error = retainServiceAuthorityFailure(cause);
    let restored: boolean;
    try {
      const owner = owners.getStore();
      restored = await (owner ? owner.compensate(restore) : restore());
    } catch (recoveryError) {
      const failure = new AggregateError(
        [error, recoveryError],
        `${error instanceof Error ? error.message : String(error)}\nThe previous service definition could not be restored.`,
      );
      throw error instanceof GatewayServiceAuthorityError
        ? new GatewayServiceAuthorityError(failure, "recovery-pending")
        : failure;
    }
    throw error instanceof GatewayServiceAuthorityError
      ? new GatewayServiceAuthorityError(
          error,
          error.outcome === "recovery-pending"
            ? error.outcome
            : restored
              ? "restored"
              : (error.outcome ?? "unchanged"),
        )
      : error;
  }
}
