// A reload's replacement reservation on one plugin instance.
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { currentPluginWorkHoldsPendingReplacement } from "./plugin-instance-scope.js";

/** Records whether a reload has reserved an instance and when that reload settles. */
export class PluginReplacementReservation {
  private settled?: ReturnType<typeof createDeferredCore<void>>;

  constructor(private readonly pluginId: string) {}

  get pending(): boolean {
    return this.settled !== undefined;
  }

  /** Reserve the instance for a reload; any release ends the reservation and settles waiting callers. */
  reserve(): () => void {
    const settled = (this.settled ??= createDeferredCore());
    return () => {
      if (this.settled === settled) {
        this.settled = undefined;
        settled.resolve();
      }
    };
  }

  /**
   * Settlement a refused fresh host call may wait for before resolving its
   * target again. Offered only after quiesce, when the reload no longer waits on
   * retained work, and never to plugin code or work the drain is joining, since
   * the reload could be waiting on that caller.
   */
  private freshCallWait(accepting: boolean): Promise<void> | undefined {
    return this.settled &&
      !accepting &&
      !pluginInstanceInvocation.getStore() &&
      !currentPluginWorkHoldsPendingReplacement()
      ? this.settled.promise
      : undefined;
  }

  /** The refusal for a fresh call, carrying the reload settlement when one is offered. */
  refuseFreshCall(accepting: boolean): PluginInstanceUnavailableError {
    return new PluginInstanceUnavailableError(this.pluginId, this.freshCallWait(accepting));
  }
}
