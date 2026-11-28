import { AsyncResource } from "node:async_hooks";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import type { PluginInstanceInvocation } from "./plugin-instance-invocation.types.js";
import { PluginFactoryBinding } from "./plugin-instance-owned-values.js";
import {
  getPluginOriginalValue,
  pluginInvocationContext,
  type PluginInstanceHandle,
} from "./plugin-instance-scope.js";
import type { PluginInstanceCallLease } from "./plugin-instance.types.js";
import { mapPluginReturnPromise, resolvePluginReturnPromise } from "./plugin-return-value.js";
import type { PluginRegistry } from "./registry-types.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

// Native await ignores a native Promise's own then override; keep that boundary here.
// oxlint-disable-next-line typescript/unbound-method -- Calls below supply the normalized Promise as receiver.
const promiseThen = Promise.prototype.then;

/** An iterator keeps the admission that owns its pending protocol operations. */
type PluginIteratorAdmission = {
  readonly origin: PluginInstanceInvocation;
  reenter: <T>(run: () => T) => T;
  readonly done: boolean;
  readonly active: boolean;
  invoke: <T>(run: () => T) => T;
  close: () => void;
  call: (key: PropertyKey, method: Function | undefined, args: unknown[]) => Promise<unknown>;
};

export type PluginIteratorBindingOwner = {
  instance: PluginInstanceHandle;
  enter: <T>(token: object, run: () => T) => T;
  lease: () => PluginInstanceCallLease;
  hasToken: (token: object) => boolean;
  isConsumerToken: (token: object) => boolean;
};

/** One binding owns its iterators' captured scopes, admission, and protocol settlement. */
export function createPluginIteratorBindings(
  bindings: PluginIteratorBindingOwner,
  factory: object,
  admit: <T>(run: () => T) => T,
) {
  const iterators = new WeakMap<object, PluginIteratorAdmission>();
  const prepareInvocation = (token: object, parent?: PluginInstanceInvocation) => {
    const context = pluginInvocationContext.getStore();
    const consumer = bindings.isConsumerToken(token);
    // Iterator creation runs inside its admitting call; renewals keep that original parent.
    const origin = parent ?? pluginInstanceInvocation.getStore()!;
    const held: { registry?: PluginRegistry } = {};
    // Capture once: replaying AsyncLocalStorage.run copies Node's context map per event.
    const resource = bindings.enter(token, () => {
      held.registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
      return new AsyncResource("OpenClawPluginStream");
    });
    return {
      origin,
      reenter: <T>(run: () => T): T => {
        if (consumer && !bindings.hasToken(token)) {
          throw new Error(`Plugin ${bindings.instance.pluginId} consumer is closed`);
        }
        return resource.runInAsyncScope(() => pluginInstanceInvocation.run(origin, run));
      },
      assertCurrent: () => {
        context?.lookup(bindings.instance);
        const current = pluginInvocationContext.getStore();
        if (current !== context) {
          current?.lookup(bindings.instance);
        }
      },
      resource,
      close: () => {
        held.registry = undefined;
        resource.emitDestroy();
      },
    };
  };
  const admitIterator = (value: object): PluginIteratorAdmission => {
    // Only this binding's views share a lease; other consumers retain their own fencing.
    const iterator = PluginFactoryBinding.belongsTo(value, factory)
      ? getPluginOriginalValue(value, bindings.instance)!
      : value;
    const current = iterators.get(iterator);
    if (current?.active || current?.done) {
      return current;
    }
    const create = () => admit(() => createIteratorAdmission(iterator, current));
    return current ? current.reenter(create) : create();
  };

  const createIteratorAdmission = (
    iterator: object,
    previous?: PluginIteratorAdmission,
  ): PluginIteratorAdmission => {
    const { token, release } = bindings.lease();
    let invocation: ReturnType<typeof prepareInvocation>;
    try {
      invocation = prepareInvocation(token, previous?.origin);
    } catch (error) {
      void release();
      throw error;
    }
    let state: "open" | "returned" | "done" = "open";
    let active = true;
    let pending = 0;
    let closed = false;
    const settle = () => {
      if (state === "done" && pending === 0 && !closed) {
        closed = true;
        invocation.close();
      }
      if (state !== "open" && pending === 0 && active) {
        active = false;
        return release();
      }
      return undefined;
    };
    const releaseOperation = () => {
      pending -= 1;
      return settle();
    };
    const assertActive = () => {
      if (!active || !bindings.hasToken(token)) {
        throw new Error(`Plugin ${bindings.instance.pluginId} stream is closed`);
      }
    };
    const invoke = <T>(run: () => T): T => {
      pending += 1;
      try {
        try {
          assertActive();
          invocation.assertCurrent();
        } catch (error) {
          state = "done";
          throw error;
        }
        return invocation.resource.runInAsyncScope(() => {
          const result = run();
          const completion = resolvePluginReturnPromise(result);
          if (completion) {
            const settled = mapPluginReturnPromise(
              completion,
              async (value) => {
                await releaseOperation();
                return value;
              },
              async (error: unknown) => {
                await releaseOperation()?.catch(() => {});
                throw error;
              },
            );
            // SAFETY: Promise-like reads keep their resolved value while settling the stream lease.
            return settled.value as T;
          }
          void releaseOperation();
          return result;
        });
      } catch (error) {
        void releaseOperation();
        throw error;
      }
    };
    const finishOperation = (value: unknown) => {
      const completion = releaseOperation();
      return completion ? completion.then(() => value) : value;
    };
    const onError = (error: unknown): Promise<never> => {
      state = "done";
      const completion = releaseOperation();
      if (completion) {
        return completion.then(() => {
          throw error;
        });
      }
      throw error;
    };
    const onResult = (next: unknown, returned = false) => {
      try {
        if (next === null || (typeof next !== "object" && typeof next !== "function")) {
          throw new TypeError("Plugin async iterator result must be an object");
        }
        assertActive();
        state = Reflect.get(next, "done") ? "done" : returned ? "returned" : state;
      } catch (error) {
        return onError(error);
      }
      // Cleanup failures override the result without releasing the operation twice.
      return finishOperation(next);
    };
    const onReturn = (next: unknown) => onResult(next, true);
    const onReturnValue = (value: unknown) => finishOperation({ done: true, value });
    const call = (key: PropertyKey, method: Function | undefined, args: unknown[]) => {
      pending += 1;
      try {
        if (!method) {
          if (key !== "return") {
            throw new TypeError("Plugin iterator method must be callable");
          }
          state = "done";
          return promiseThen.call(Promise.resolve(args[0]), onReturnValue, onError);
        }
        return promiseThen.call(
          Promise.resolve(Reflect.apply(method, iterator, args)),
          key === "return" ? onReturn : onResult,
          onError,
        );
      } catch (error) {
        try {
          return onError(error);
        } catch (rejection) {
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Synchronous plugin throws retain their exact rejection value.
          return Promise.reject(rejection);
        }
      }
    };
    const admission: PluginIteratorAdmission = {
      origin: invocation.origin,
      reenter: (run) => {
        try {
          invocation.assertCurrent();
          return invocation.reenter(run);
        } catch (error) {
          admission.close();
          throw error;
        }
      },
      get done() {
        return state === "done";
      },
      get active() {
        return active;
      },
      invoke,
      close: () => {
        state = "done";
        void settle();
      },
      call: (key, method, args) => {
        // Completed return is protocol cleanup and executes no plugin code.
        if (state === "done" && key === "return") {
          return Promise.resolve(args[0]).then((value) => ({ done: true, value }));
        }
        if (state === "done") {
          // Preserve terminal results without reentering source methods or getters.
          return Promise.resolve().then(() =>
            admit(() => {
              if (key === "throw") {
                throw args[0];
              }
              return { done: true, value: undefined };
            }),
          );
        }
        try {
          assertActive();
          invocation.assertCurrent();
          return invocation.resource.runInAsyncScope(call, undefined, key, method, args);
        } catch (error) {
          state = "done";
          const reject = () => {
            throw error;
          };
          return Promise.resolve(settle()).then(reject, reject);
        }
      },
    };
    iterators.set(iterator, admission);
    previous?.close();
    return admission;
  };

  return { iterators, admitIterator };
}
