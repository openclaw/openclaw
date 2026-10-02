import type { PluginInstanceCallLease } from "./plugin-instance.types.js";
import { mapPluginReturnPromise, resolvePluginReturnPromise } from "./plugin-return-value.js";

type InterruptibleCallBindings = {
  lifecycleSignal: AbortSignal;
  lease: () => PluginInstanceCallLease;
  invoke: <T>(run: () => T, lease: PluginInstanceCallLease) => T;
};

export class PluginInterruptibleCalls {
  private readonly controllers = new Set<AbortController>();

  run<T>(
    signal: AbortSignal,
    run: (signal: AbortSignal) => T,
    bindings: InterruptibleCallBindings,
  ): T {
    signal.throwIfAborted();
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal, bindings.lifecycleSignal]);
    const sourceLease = bindings.lease();
    let released = false;
    const lease: PluginInstanceCallLease = {
      token: sourceLease.token,
      release: () => {
        if (released) {
          return undefined;
        }
        released = true;
        return sourceLease.release();
      },
    };
    const interrupt = () => void lease.release();
    const finish = () => {
      combined.removeEventListener("abort", interrupt);
      this.controllers.delete(controller);
    };
    this.controllers.add(controller);
    combined.addEventListener("abort", interrupt, { once: true });
    try {
      return bindings.invoke(() => {
        const value = run(combined);
        const completion = resolvePluginReturnPromise(value);
        if (!completion) {
          combined.throwIfAborted();
          finish();
          return value;
        }
        const settled = mapPluginReturnPromise(
          completion,
          (result) => {
            finish();
            combined.throwIfAborted();
            return result;
          },
          (error) => {
            finish();
            combined.throwIfAborted();
            throw error;
          },
        );
        // SAFETY: The mapped promise retains the callback's resolved type.
        return settled.value as T;
      }, lease);
    } catch (error) {
      finish();
      throw error;
    }
  }

  quiesce(reason: unknown): void {
    for (const controller of this.controllers) {
      controller.abort(reason);
    }
  }
}
