import { projectSource } from "../../lib/reactive/projection.ts";

/** RPC admission and drafts mutate synchronously; rendering observes their publication. */
export function observeSkillState<T extends object>(initial: T) {
  let notify = () => {};
  const state = new Proxy(initial, {
    set(target, key, value, receiver) {
      if (Object.is(Reflect.get(target, key), value)) {
        return true;
      }
      const updated = Reflect.set(target, key, value, receiver);
      notify();
      return updated;
    },
  });
  const projection = projectSource(state, {
    read: (source) => source,
    subscribe: (_source, listener) => {
      notify = listener;
      return () => {
        notify = () => {};
      };
    },
    equality: "revision",
  });
  return {
    state,
    read: projection.read,
    subscribe: projection.subscribe,
    dispose: projection.dispose,
    edit(this: void, change: (value: T) => void) {
      change(state);
      notify();
    },
  };
}
