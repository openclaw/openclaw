import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Plugin SDK chunks and the host runtime must share the same process-launch fence.
const commandExecutionAuthority = resolveGlobalSingleton(
  Symbol.for("openclaw.commandExecutionAuthority"),
  () => new AsyncLocalStorage<() => void>(),
);

/** Revalidate any caller-owned authority immediately before a child process is launched. */
export function assertCommandExecutionAuthority(): void {
  commandExecutionAuthority.getStore()?.();
}

/** Carry a live host-owned assertion through asynchronous tool preparation. */
export async function withCommandExecutionAuthority<T>(
  assertCurrent: () => void,
  run: () => Promise<T>,
): Promise<T> {
  const inherited = commandExecutionAuthority.getStore();
  let active = true;
  const assertAuthority = () => {
    inherited?.();
    if (!active) {
      throw new Error("Command execution authority is no longer active.");
    }
    assertCurrent();
  };
  try {
    assertAuthority();
    return await commandExecutionAuthority.run(assertAuthority, run);
  } finally {
    active = false;
  }
}
