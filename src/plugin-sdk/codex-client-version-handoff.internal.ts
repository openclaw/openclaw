/**
 * Parent-to-worker handoff for the Codex client version. The process that runs
 * Codex turns owns the decision; catalog workers report the value their parent
 * captured for the request instead of selecting a Codex binary themselves.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type HandedOffCodexClientVersion = Readonly<{ version: string | undefined }>;

// The worker host and plugin SDK aliases can load separate copies of this module.
const handedOff = resolveGlobalSingleton(
  Symbol.for("openclaw.codexClientVersionHandoff"),
  () => new AsyncLocalStorage<HandedOffCodexClientVersion>(),
);

/** Runs worker work with the parent's decision; undefined means the bundled pin. */
export function withHandedOffCodexClientVersion<T>(
  version: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return handedOff.run({ version }, operation);
}

export function readHandedOffCodexClientVersion(): HandedOffCodexClientVersion | undefined {
  return handedOff.getStore();
}
