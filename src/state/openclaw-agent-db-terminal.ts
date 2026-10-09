import { spawnSync } from "node:child_process";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { assertSqliteIntegrityInWorker } from "../infra/sqlite-integrity-worker.js";
import { readSqliteInspectionBudget } from "../infra/sqlite-readonly-worker.js";
import { readGlobalSingleton } from "../shared/global-singleton.js";
import type { agentDatabaseLifecycle } from "./openclaw-agent-db-lifecycle.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

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

/** Only latched integrity failures need a fresh native check after external repair. */
export function revalidateAgentDatabaseTerminalOpen(pathname: string): void {
  const latch = terminalLatch();
  const failure = latch?.peek(pathname);
  if (latch && failure?.name === "SqliteIntegrityError") {
    const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.databaseVerify);
    const child = spawnSync(
      process.execPath,
      [...resolveRuntimeWorkerArgv(workerUrl), "--openclaw-database-verify-sync", pathname],
      {
        timeout: readSqliteInspectionBudget("integrity check", pathname).timeoutMs,
        killSignal: "SIGKILL",
        stdio: "ignore",
      },
    );
    if (child.error || child.status !== 0) {
      throw failure;
    }
    latch.clear(pathname);
  }
  assertAgentDatabaseTerminalOpenAllowed(pathname);
}

export async function revalidateAgentDatabaseTerminalOpenAsync(
  pathname: string,
  assertCurrent?: () => void,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const latch = terminalLatch();
  const failure = latch?.peek(pathname);
  if (latch && failure?.name === "SqliteIntegrityError") {
    await assertSqliteIntegrityInWorker(pathname, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS, signal);
    assertCurrent?.();
    if (latch.peek(pathname) === failure) {
      latch.clear(pathname);
    }
  }
  assertCurrent?.();
  assertAgentDatabaseTerminalOpenAllowed(pathname);
}
