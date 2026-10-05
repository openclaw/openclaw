import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "./global-singleton.js";

export type PreparedEffectUse = {
  assertCurrent: () => void;
  initiate: <T>(effect: () => T) => T;
  release: () => void;
  persist: <T>(run: (assertCurrent: () => void) => Promise<T>) => Promise<T>;
};
export type EffectPreparation = () => Promise<PreparedEffectUse>;

const effectScope = resolveGlobalSingleton(
  Symbol.for("openclaw.effectAuthority"),
  () => new AsyncLocalStorage<EffectPreparation | undefined>(),
);

/** Host binding: adapters receive initiation and scope restoration, never a mutation capability. */
export async function withEffectPreparation<T>(
  prepare: EffectPreparation | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!prepare) {
    return await run();
  }
  let open = true;
  const assertOpen = () => {
    if (!open) {
      throw new Error("Effect authority is no longer active");
    }
  };
  const bound = async (): Promise<PreparedEffectUse> => {
    assertOpen();
    const use = await prepare();
    try {
      assertOpen();
      return {
        assertCurrent() {
          assertOpen();
          use.assertCurrent();
        },
        initiate(effect) {
          return use.initiate(() => {
            assertOpen();
            return effect();
          });
        },
        release: () => use.release(),
        persist: (write) =>
          use.persist((assertCurrent) =>
            write(() => {
              assertOpen();
              assertCurrent();
            }),
          ),
      };
    } catch (error) {
      use.release();
      throw error;
    }
  };
  try {
    return await effectScope.run(bound, run);
  } finally {
    open = false;
  }
}

/** Database writers retain this use through their existing commit/settlement boundary. */
export function prepareEffectAuthority(): Promise<PreparedEffectUse | undefined> {
  return effectScope.getStore()?.() ?? Promise.resolve(undefined);
}

/** Capture before queues; each native request, retry, or disclosure prepares a fresh use. */
export function captureEffectAuthority() {
  const prepare = effectScope.getStore();
  return {
    active: prepare !== undefined,
    run<T>(run: () => T): T {
      return effectScope.run(prepare, run);
    },
    async initiate<T>(effect: () => T | Promise<T>): Promise<T> {
      const use = prepare ? await prepare() : undefined;
      try {
        return use ? use.initiate(effect) : effect();
      } finally {
        use?.release();
      }
    },
  };
}
