import { AsyncLocalStorage } from "node:async_hooks";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

type RequestAuthority = { assertCurrent: () => void; beforeRequest: () => void };

// Host runtime and plugin SDK chunks must retain the same request-owned fence.
const requestAuthority = resolveGlobalSingleton(
  Symbol.for("openclaw.guardedFetchRequestAuthority"),
  () => new AsyncLocalStorage<RequestAuthority>(),
);

/** Capture before transport preparation so redirects retain the original caller. */
export function captureGuardedFetchRequestAuthority(): (() => void) | undefined {
  const authority = requestAuthority.getStore();
  return authority
    ? () => {
        authority.assertCurrent();
        authority.beforeRequest();
      }
    : undefined;
}

function invokeSynchronousGuard(guard: (() => void) | undefined): void {
  const result: unknown = guard?.();
  if (isPromiseLike(result)) {
    void Promise.resolve(result).catch(() => undefined);
    throw new TypeError("Guarded request authority must be synchronous.");
  }
}

/** Carry a host-owned assertion through provider preparation without granting new authority. */
export async function withGuardedFetchRequestAuthority<T>(
  assertCurrent: (() => void) | undefined,
  run: (assertCurrent: (() => void) | undefined) => Promise<T>,
  beforeRequest?: () => void,
): Promise<T> {
  const inherited = requestAuthority.getStore();
  if (!assertCurrent && !beforeRequest && !inherited) {
    return await run(undefined);
  }
  let active = true;
  const assertAuthority = () => {
    inherited?.assertCurrent();
    if (!active) {
      throw new Error("Guarded request authority is no longer active.");
    }
    invokeSynchronousGuard(assertCurrent);
  };
  try {
    assertAuthority();
    return await requestAuthority.run(
      {
        assertCurrent: assertAuthority,
        beforeRequest: () => {
          inherited?.beforeRequest();
          invokeSynchronousGuard(beforeRequest);
        },
      },
      () => run(assertAuthority),
    );
  } finally {
    active = false;
  }
}
