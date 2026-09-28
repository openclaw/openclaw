import { AsyncLocalStorage } from "node:async_hooks";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

// Host runtime and plugin SDK chunks must retain the same request-owned fence.
const requestAuthority = resolveGlobalSingleton(
  Symbol.for("openclaw.guardedFetchRequestAuthority"),
  () => new AsyncLocalStorage<() => void>(),
);

/** Capture before transport preparation so redirects retain the original caller. */
export function captureGuardedFetchRequestAuthority(): (() => void) | undefined {
  return requestAuthority.getStore();
}

/** Carry a host-owned assertion through provider preparation without granting new authority. */
export async function withGuardedFetchRequestAuthority<T>(
  assertCurrent: (() => void) | undefined,
  run: (assertCurrent: (() => void) | undefined) => Promise<T>,
): Promise<T> {
  const inherited = requestAuthority.getStore();
  if (!assertCurrent && !inherited) {
    return await run(undefined);
  }
  let active = true;
  const assertAuthority = () => {
    inherited?.();
    if (!active) {
      throw new Error("Guarded request authority is no longer active.");
    }
    const result: unknown = assertCurrent?.();
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError("Guarded request authority must be synchronous.");
    }
  };
  try {
    assertAuthority();
    return await requestAuthority.run(assertAuthority, () => run(assertAuthority));
  } finally {
    active = false;
  }
}
