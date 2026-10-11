import { AsyncLocalStorage } from "node:async_hooks";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import type { CommandOptions, SpawnResult } from "../process/exec.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import {
  getServiceInspectionClock,
  runServiceInspectionGuard,
} from "./service-inspection-budget.js";

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

type ServiceAuthority = {
  assertCurrent: () => void;
  compensate: <T>(operation: () => Promise<T>) => Promise<T>;
  updateOwned: boolean;
  originalRoot?: string;
  nativeCommand?: GatewayServiceNativeCommand;
  nativeDispatch?: NativeDispatch;
};
const owners = new AsyncLocalStorage<ServiceAuthority | undefined>();

export type GatewayServiceNativeCommand = (
  argv: string[],
  options: CommandOptions,
) => Promise<SpawnResult>;
type NativeDispatch = (
  argv: string[],
  options: CommandOptions,
  assertSubmittedScope: () => void,
) => Promise<SpawnResult>;

/** Only the current update interval can supply native process custody. */
export function getGatewayServiceUpdateNativeCommand(): GatewayServiceNativeCommand | undefined {
  return owners.getStore()?.nativeCommand;
}

/** Bind the caller and every inherited update grant to this native-operation lifetime.
 * Inherited async work and retained callbacks must fail after closure. */
export async function withGatewayServiceUpdateAuthority<T>(
  assertOwner: (() => void) | undefined,
  operation: (assertCurrent: () => void) => Promise<T>,
  options?: {
    updateOwned?: boolean;
    assertRecoveryCurrent?: () => void;
    originalRoot?: string;
    nativeCommand?: GatewayServiceNativeCommand;
  },
): Promise<T> {
  const parent = owners.getStore();
  const originalRoot = parent?.originalRoot ?? options?.originalRoot;
  const closedError = () =>
    new GatewayServiceAuthorityError(new Error("Native service authority has closed."));
  let active = true;
  let accepting = true;
  let tail: Promise<unknown> = Promise.resolve();
  const pending = new Set<Promise<SpawnResult>>();
  const nativeCommand = options?.nativeCommand;
  const track = (work: Promise<SpawnResult>) => {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  };
  const assertScope = (compensating = false) => {
    if (!active) {
      throw closedError();
    }
    try {
      // Caller assertions can borrow a native lock whose checks consult this scope.
      // Evaluate them in their original context, retaining every inherited updater fence.
      runServiceInspectionGuard(() =>
        owners.run(parent, () => {
          parent?.assertCurrent();
          options?.assertRecoveryCurrent?.();
          if (!compensating || !options?.assertRecoveryCurrent) {
            assertOwner?.();
          }
        }),
      );
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
  const owner: ServiceAuthority = {
    assertCurrent,
    updateOwned: parent?.updateOwned || (options?.updateOwned ?? true),
    originalRoot,
    compensate: (restore) =>
      owners.run(parent, () =>
        withGatewayServiceUpdateAuthority(() => assertScope(true), restore, {
          originalRoot,
          nativeCommand,
        }),
      ),
  };
  if (nativeCommand) {
    // Explicitly inherited runners keep one native queue. Each submission adds
    // its caller's live guard after earlier children have released the parent.
    const dispatch: NativeDispatch =
      (nativeCommand === parent?.nativeCommand ? parent?.nativeDispatch : undefined) ??
      (async (argv, commandOptions, assertSubmittedScope) => {
        if (!active || !accepting) {
          throw closedError();
        }
        const command = [...argv];
        const selected = {
          ...commandOptions,
          baseEnv: { ...commandOptions.baseEnv },
          env: { ...commandOptions.env },
        };
        const now = getServiceInspectionClock(() => Date.now());
        const deadline =
          selected.timeoutMs === undefined
            ? undefined
            : now() + resolveTimerTimeoutMs(selected.timeoutMs, 1);
        const expired = () =>
          Object.assign(new Error("Native command admission timed out."), { code: "ETIMEDOUT" });
        const previous = tail;
        let started = false;
        const work = track(
          previous.then(async () => {
            if (!active || !accepting) {
              throw closedError();
            }
            assertCurrent();
            assertSubmittedScope();
            selected.signal?.throwIfAborted();
            const remaining = deadline === undefined ? undefined : deadline - now();
            if (remaining !== undefined && remaining <= 0) {
              throw expired();
            }
            started = true;
            const result = await nativeCommand(command, { ...selected, timeoutMs: remaining });
            // Custody loss must not hide an unsettled writer and permit compensation.
            if (result.cleanup === "uncertain") {
              throw new CommandProcessCleanupError();
            }
            assertCurrent();
            assertSubmittedScope();
            return result;
          }),
        );
        tail = work.then(
          () => undefined,
          () => undefined,
        );
        // Admission expiry cannot release the preceding native child or let a
        // later submission pass it. The queued work remains tracked until joined.
        const admitted = await awaitWithinDeadline(() => previous, deadline, now);
        if (admitted === ABSOLUTE_DEADLINE_EXPIRED && !started) {
          throw expired();
        }
        return await work;
      });
    const bound: GatewayServiceNativeCommand = (argv, commandOptions) => {
      if (!active || !accepting) {
        return Promise.reject(closedError());
      }
      return track(dispatch(argv, commandOptions, assertCurrent));
    };
    owner.nativeCommand = bound;
    owner.nativeDispatch = dispatch;
  }
  try {
    return await owners.run(owner, async () => {
      const invoke = async () => {
        try {
          const result = await operation(assertCurrent);
          if (!nativeCommand) {
            assertCurrent();
          }
          return result;
        } catch (error) {
          throw retainServiceAuthorityFailure(error);
        }
      };
      if (!nativeCommand) {
        return await invoke();
      }
      const [outcome] = await Promise.allSettled([invoke()]);
      accepting = false;
      if (outcome.status === "rejected") {
        active = false;
      }
      const failures: unknown[] = [];
      while (pending.size) {
        for (const settlement of await Promise.allSettled(pending)) {
          if (settlement.status === "rejected") {
            failures.push(settlement.reason);
          }
        }
      }
      if (failures.length) {
        throw new AggregateError(
          outcome.status === "rejected" ? [outcome.reason, ...failures] : failures,
          "Native command scope did not settle successfully.",
        );
      }
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
      assertCurrent();
      return outcome.value;
    });
  } finally {
    accepting = false;
    active = false;
    // Revoking queued work never acknowledges the currently running child.
    await Promise.allSettled(pending);
    delete owner.nativeDispatch;
    delete owner.nativeCommand;
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

/** Original-root evidence is usable only while its inherited owner remains live. */
export function readGatewayServiceUpdateOriginalRoot(): string | undefined {
  const owner = owners.getStore();
  owner?.assertCurrent();
  return owner?.originalRoot;
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
