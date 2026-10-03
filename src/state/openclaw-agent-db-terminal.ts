import { readGlobalSingleton } from "../shared/global-singleton.js";
import type { agentDatabaseLifecycle } from "./openclaw-agent-db-lifecycle.js";

/** Read the existing damage latch without acquiring the writable database lifecycle. */
export function assertAgentDatabaseTerminalOpenAllowed(pathname: string): void {
  // SAFETY: This key is registered only by the agent database lifecycle owner with its terminal latch.
  const owner = readGlobalSingleton(Symbol.for("openclaw.agentDatabaseLifecycle")) as
    | Pick<typeof agentDatabaseLifecycle, "terminal">
    | undefined;
  const failure = owner?.terminal.get(pathname);
  if (failure) {
    throw failure;
  }
}
