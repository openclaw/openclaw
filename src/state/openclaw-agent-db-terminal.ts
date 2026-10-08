import { readGlobalSingleton } from "../shared/global-singleton.js";
import type { agentDatabaseLifecycle } from "./openclaw-agent-db-lifecycle.js";
import {
  confirmDatabaseVerifyWorker,
  confirmDatabaseVerifyWorkerSync,
} from "./openclaw-database-verify-client.js";

function terminalLatch() {
  // SAFETY: This key is registered only by the agent database lifecycle owner with its terminal latch.
  const owner = readGlobalSingleton(Symbol.for("openclaw.agentDatabaseLifecycle")) as
    | Pick<typeof agentDatabaseLifecycle, "terminal">
    | undefined;
  return owner?.terminal;
}

/** Read the existing damage latch without acquiring the writable database lifecycle. */
export function assertAgentDatabaseTerminalOpenAllowed(pathname: string): void {
  const failure = terminalLatch()?.get(pathname);
  if (failure) {
    throw failure;
  }
}

/** A fresh synchronous admission can recover after another process repairs the file. */
export function revalidateAgentDatabaseTerminalOpen(pathname: string): void {
  const latch = terminalLatch();
  const failure = latch?.peek(pathname);
  if (latch && failure?.name === "SqliteIntegrityError") {
    const confirmation = confirmDatabaseVerifyWorkerSync(pathname);
    if (confirmation.status === "healthy") {
      latch.clear(pathname, { expectedError: failure, generation: confirmation.generation });
    }
  } else {
    assertAgentDatabaseTerminalOpenAllowed(pathname);
    return;
  }
  const remaining = latch?.peek(pathname);
  if (remaining) {
    throw remaining;
  }
}

/** Gateway admission awaits the native verifier; healthy operations never start a child. */
export async function revalidateAgentDatabaseTerminalOpenAsync(
  pathname: string,
  assertCurrent?: () => void,
  signal?: AbortSignal,
): Promise<void> {
  const latch = terminalLatch();
  const failure = latch?.peek(pathname);
  if (latch && failure?.name === "SqliteIntegrityError") {
    assertCurrent?.();
    const confirmation = await confirmDatabaseVerifyWorker(
      { path: pathname, kind: "agent", label: pathname },
      { assertCurrent, signal },
    );
    if (confirmation.status === "healthy") {
      latch.clear(pathname, { expectedError: failure, generation: confirmation.generation });
    }
  } else {
    assertCurrent?.();
    assertAgentDatabaseTerminalOpenAllowed(pathname);
    return;
  }
  assertCurrent?.();
  const remaining = latch?.peek(pathname);
  if (remaining) {
    throw remaining;
  }
}
