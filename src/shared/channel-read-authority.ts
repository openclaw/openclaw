import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "./global-singleton.js";

// Host and installed-plugin SDK chunks must share the same invocation scope.
const authorityScope = resolveGlobalSingleton(
  Symbol.for("openclaw.channelReadAuthority"),
  () => new AsyncLocalStorage<() => void>(),
);

/** Capture at request submission; retain this exact check through queues and retries. */
export function captureChannelReadAuthority(): (() => void) | undefined {
  return authorityScope.getStore();
}

/** Host-only entry: neither model params nor plugin declarations mint read authority. */
export async function withChannelReadAuthority<T>(
  assertCurrent: (() => void) | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!assertCurrent) {
    return await run();
  }
  const parent = authorityScope.getStore();
  let open = true;
  const assertAuthority = () => {
    parent?.();
    if (!open) {
      throw new Error("Channel read authority is no longer active.");
    }
    assertCurrent();
  };
  assertAuthority();
  try {
    return await authorityScope.run(assertAuthority, run);
  } finally {
    try {
      // Fence both results and errors, including work already issued before revocation.
      assertAuthority();
    } finally {
      open = false;
    }
  }
}
