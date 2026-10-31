import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { createAgentRunRestartAbortError } from "../agents/run-termination.js";
import { isAgentEventLifecycleGenerationCurrent } from "../infra/agent-events.js";
import { throwIfSettledRejected } from "../infra/error-graph-internal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hasGatewayContextOwner } from "../plugins/runtime/gateway-request-scope.js";
import { getProcessCleanupBudget } from "../process/supervisor/cleanup-budget.js";
import { captureGatewaySessionWorkAdmissionInterruption } from "../sessions/session-controller.lifecycle-work.js";
import { sessionControllerMailboxes } from "../sessions/session-controller.mailbox.js";
import { listRpcSourceEntries } from "../sessions/session-controller.rpc-sources.js";
import { activeSessionOperations } from "../sessions/session-controller.state.js";
import { captureSessionControllerStop, stopSession } from "../sessions/session-controller.stop.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { recordGatewayShutdownWarning } from "./server-shutdown.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");

export type GatewayRunShutdownParams = {
  resolveGatewayContext: GatewayContextResolver;
  /** Snapshot live owners once, before cancellation changes their running state. */
  persistRunningSessionsForRestart?: (signal: AbortSignal) => Promise<void>;
  terminateRunningSubagentsForShutdown?: () => Promise<void>;
  cancelReceivedWork?: (reason?: Error) => void;
};

/** A committed shutdown records running sessions, then aborts instead of waiting for models. */
export async function prepareGatewayRunShutdown(
  params: GatewayRunShutdownParams & {
    warnings: string[];
  },
): Promise<{ released: Promise<void>; failure?: { error: unknown } }> {
  const sources = listRpcSourceEntries().filter(([, entry]) =>
    hasGatewayContextOwner(entry.input, params.resolveGatewayContext),
  );
  const capture = captureSessionControllerStop({
    inputs: [...sessionControllerMailboxes()].flatMap((mailbox) =>
      mailbox.entries.filter((input) =>
        hasGatewayContextOwner(input, params.resolveGatewayContext),
      ),
    ),
    operations: [...activeSessionOperations()].filter((operation) =>
      hasGatewayContextOwner(operation, params.resolveGatewayContext),
    ),
  });
  const effects = captureGatewaySessionWorkAdmissionInterruption(params.resolveGatewayContext);
  const persistence = new AbortController();
  // Marker writes share the lifecycle owner's deadline, including worker/writer queueing.
  const budget = getProcessCleanupBudget();
  const persistenceMs = budget ? Math.max(0, budget.deadline - performance.now()) : 1_000;
  let failure: { error: unknown } | undefined;
  try {
    await raceWithTimeout(
      async () => params.persistRunningSessionsForRestart?.(persistence.signal),
      persistenceMs,
      () => {
        const error = new Error(
          `Shutdown session persistence did not settle within ${persistenceMs}ms`,
        );
        persistence.abort(error);
        throw error;
      },
      { ref: false },
    );
  } catch (error) {
    persistence.abort(error);
    shutdownLog.warn(`Restart marker persistence failed: ${String(error)}`);
    failure = { error };
  }
  try {
    await raceWithTimeout(
      async () => params.terminateRunningSubagentsForShutdown?.(),
      1_000,
      () => {
        throw new Error("Shutdown subagent settlement did not settle within 1000ms");
      },
      { ref: false },
    );
  } catch (error) {
    failure ??= { error };
  }
  stopSession({
    capture,
    source: "restart",
    onError: (_target, error) => {
      shutdownLog.warn(`failed to cancel work during shutdown: ${String(error)}`);
      recordGatewayShutdownWarning(params.warnings, "session-abort");
      return "continue";
    },
    // Shutdown has no terminal chat presentation. The next ordinary input explains
    // the restart; cancellation still runs the owner's normal abort/finalization path.
    cancelInput: (_input, cancel) => cancel(),
    cancelOperation: (operation, cancel) =>
      operation.lifecycleGeneration !== undefined &&
      isAgentEventLifecycleGenerationCurrent(operation.lifecycleGeneration) &&
      hasGatewayContextOwner(operation, params.resolveGatewayContext)
        ? cancel()
        : false,
  });
  const reason = createAgentRunRestartAbortError();
  params.cancelReceivedWork?.(reason);
  const interrupted = effects.interrupt(reason);
  // Raw model/tool ownership is resource cleanup, not permission to wait forever.
  const terminalPersistence = sources.flatMap(([, source]) =>
    source.adapter.projectSessionTerminalPersistence
      ? [source.adapter.projectSessionTerminalPersistence]
      : [],
  );
  const released = Promise.allSettled([
    capture.settled,
    interrupted.released,
    ...terminalPersistence,
  ]).then((results) => throwIfSettledRejected(results, "Session shutdown persistence failed"));
  return { failure, released };
}
