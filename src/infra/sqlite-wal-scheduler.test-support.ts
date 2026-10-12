import { AsyncLocalStorage } from "node:async_hooks";
import { createGatewaySchedulerClock } from "../test-utils/gateway-scheduler-clock.js";
import { GatewayScheduler } from "./gateway-scheduler.js";

/** Trigger selected WAL work through real scheduler dispatch at a controlled admission boundary. */
export function observeSqliteWalPeriodicWork(select: () => boolean = () => true) {
  const scopeDescriptor = Object.getOwnPropertyDescriptors(GatewayScheduler.prototype).scope;
  const originalScope = scopeDescriptor.value;
  if (!originalScope) {
    throw new Error("Expected the scheduler's own scope implementation");
  }
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = new GatewayScheduler({ clock: clock.clock });
  let periodic: (() => void | Promise<unknown>) | undefined;
  GatewayScheduler.prototype.scope = function (this: GatewayScheduler) {
    if (!select()) {
      return originalScope.call(this);
    }
    const scope = originalScope.call(scheduler);
    return {
      ...scope,
      schedule(params) {
        if (params.id.startsWith("sqlite-wal:") && params.id.endsWith(":periodic")) {
          if (periodic) {
            throw new Error("Expected one published WAL maintenance owner");
          }
          const registrationContext = AsyncLocalStorage.snapshot();
          periodic = () => {
            if (scope.signal.aborted) {
              return;
            }
            // Move only this job's next deadline; retain its owner, callback, and authority.
            // The separate checkpoint tick stays pending while normal dispatch owns the join.
            registrationContext(() => scope.schedule({ ...params, delayMs: 0 }));
            return clock.wake();
          };
        }
        return scope.schedule(params);
      },
    };
  };
  return {
    restore: () => {
      Object.defineProperty(GatewayScheduler.prototype, "scope", scopeDescriptor);
    },
    get periodic() {
      if (!periodic) {
        throw new Error("Database did not register periodic WAL maintenance");
      }
      return periodic;
    },
  };
}
