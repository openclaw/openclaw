import { projectMutableSource } from "../../lib/reactive/projection.ts";

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
  const projection = projectMutableSource(state, (source) => source);
  notify = projection.publish;
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
