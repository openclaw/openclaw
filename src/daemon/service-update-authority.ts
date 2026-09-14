import { AsyncLocalStorage } from "node:async_hooks";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import type { CommandOptions, SpawnResult } from "../process/exec.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";

export const GATEWAY_UPDATE_EXECUTOR_CONTRACT = "root-spawner-v1";

const owners = new AsyncLocalStorage<() => void>();
export type GatewayServiceNativeCommand = (
  argv: string[],
  options: CommandOptions,
) => Promise<SpawnResult>;
const nativeCommands = new WeakMap<() => void, GatewayServiceNativeCommand>();

/** Only the current update interval can supply native process custody. */
export function getGatewayServiceUpdateNativeCommand(): GatewayServiceNativeCommand | undefined {
  const owner = owners.getStore();
  return owner ? nativeCommands.get(owner) : undefined;
}

/** The target CLI installs this only after binding its original update grant.
 * It remains in inherited async work after closure, where assertions must fail. */
export async function withGatewayServiceUpdateAuthority<T>(
  assertOwner: () => void,
  operation: () => Promise<T>,
  nativeCommand?: GatewayServiceNativeCommand,
): Promise<T> {
  let active = true;
  let accepting = true;
  let tail: Promise<unknown> = Promise.resolve();
  const pending = new Set<Promise<SpawnResult>>();
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Update-owned native command has closed.");
    }
    assertOwner();
  };
  assertCurrent();
  if (nativeCommand) {
    nativeCommands.set(assertCurrent, async (argv, options) => {
      if (!active || !accepting) {
        throw new Error("Update-owned native command has closed.");
      }
      const command = [...argv];
      const selected = { ...options, baseEnv: { ...options.baseEnv }, env: { ...options.env } };
      const deadline =
        selected.timeoutMs === undefined
          ? undefined
          : Date.now() + resolveTimerTimeoutMs(selected.timeoutMs, 1);
      const expired = () =>
        Object.assign(new Error("Native command admission timed out."), { code: "ETIMEDOUT" });
      const previous = tail;
      let started = false;
      const work = previous.then(async () => {
        if (!active || !accepting) {
          throw new Error("Update-owned native command has closed.");
        }
        // Another native child can suspend the parent while this call waits.
        // Only assert the parent after that child has actually settled.
        assertCurrent();
        selected.signal?.throwIfAborted();
        const remaining = deadline === undefined ? undefined : deadline - Date.now();
        if (remaining !== undefined && remaining <= 0) {
          throw expired();
        }
        started = true;
        const result = await nativeCommand(command, { ...selected, timeoutMs: remaining });
        assertCurrent();
        return result;
      });
      pending.add(work);
      tail = work.then(
        () => undefined,
        () => undefined,
      );
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      // Expiry bounds this wait, not the prior command's real lifetime. Keep
      // work in the tail so later submissions cannot pass its active predecessor.
      const admitted = await awaitWithinDeadline(() => previous, deadline);
      if (admitted === ABSOLUTE_DEADLINE_EXPIRED && !started) {
        throw expired();
      }
      return await work;
    });
  }
  try {
    return await owners.run(assertCurrent, async () => {
      if (!nativeCommand) {
        const result = await operation();
        assertCurrent();
        return result;
      }
      const [outcome] = await Promise.allSettled([Promise.resolve().then(operation)]);
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
    // Failed/cancelled callers revoke queued work but still join the command
    // already running; deleting a callback is never a cleanup acknowledgement.
    if (nativeCommand) {
      await Promise.allSettled(pending);
    }
    nativeCommands.delete(assertCurrent);
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
