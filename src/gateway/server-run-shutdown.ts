import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { createAgentRunRestartAbortError } from "../agents/run-termination.js";
import { isAgentEventLifecycleGenerationCurrent } from "../infra/agent-events.js";
import type { RestartResumeNotice } from "../infra/agent-run-registry.types.js";
import { throwIfSettledRejected } from "../infra/error-graph-internal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hasGatewayContextOwner } from "../plugins/runtime/gateway-request-scope.js";
import { getProcessCleanupBudget } from "../process/supervisor/cleanup-budget.js";
import { captureGatewaySessionWorkAdmissionInterruption } from "../sessions/session-controller.lifecycle-work.js";
import { sessionControllerMailboxes } from "../sessions/session-controller.mailbox.js";
import { listRpcSourceEntries } from "../sessions/session-controller.rpc-sources.js";
import { activeSessionOperations } from "../sessions/session-controller.state.js";
import { captureSessionControllerStop, stopSession } from "../sessions/session-controller.stop.js";
import { measureGatewayCloseStep } from "./restart-trace.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { recordGatewayShutdownWarning } from "./server-shutdown.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");

export type GatewayRunShutdownParams = {
  resolveGatewayContext: GatewayContextResolver;
  /** Snapshot live owners once, before cancellation changes their running state. */
  persistRunningSessionsForRestart?: (
    signal: AbortSignal,
    collectNotice: (notice: RestartResumeNotice) => void,
  ) => Promise<void>;
  terminateRunningSubagentsForShutdown?: () => Promise<void>;
  cancelReceivedWork?: (reason?: Error) => void;
};

/** A committed shutdown records running sessions, then aborts instead of waiting for models. */
export async function prepareGatewayRunShutdown(
  params: GatewayRunShutdownParams & {
    warnings: string[];
  },
) {
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
  const notices: RestartResumeNotice[] = [];
  // Leave time for abort finalizers and resource retirement within the owner's deadline.
  const budget = getProcessCleanupBudget();
  const remainingCleanupMs = () =>
    budget ? Math.min(10_000, Math.max(0, budget.deadline - performance.now())) : 1_000;
  const persistenceMs = remainingCleanupMs();
  let failure: { error: unknown } | undefined;
  try {
    await raceWithTimeout(
      () =>
        measureGatewayCloseStep("restart.close.session-markers", async () =>
          params.persistRunningSessionsForRestart?.(persistence.signal, (notice) =>
            notices.push(notice),
          ),
        ),
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
  if (notices.length > 0) {
    // Only committed markers reach here. A slow channel must not delay turn cancellation
    // past the cleanup budget or turn a successful save into a persistence failure.
    const controller = new AbortController();
    try {
      const outcomes = await raceWithTimeout(
        Promise.allSettled(notices.map(async (notify) => notify(controller.signal))),
        Math.min(2_000, remainingCleanupMs()),
        () => controller.abort(),
        { ref: false },
      );
      if (!outcomes || outcomes.some((outcome) => outcome.status === "rejected")) {
        shutdownLog.warn("Could not confirm every saved reply's restart notice before shutdown");
      }
    } finally {
      controller.abort();
    }
  }
  // Start child retirement, then signal every captured owner before joining any of them.
  const subagents = measureGatewayCloseStep("restart.close.subagent-settlement", async () =>
    params.terminateRunningSubagentsForShutdown?.(),
  );
  void subagents.catch(() => {});
  stopSession({
    capture,
    source: "restart",
    onError: (_target, error) => {
      shutdownLog.warn(`failed to cancel work during shutdown: ${String(error)}`);
      recordGatewayShutdownWarning(params.warnings, "session-abort");
      return "continue";
    },
    // A restart notice is not a final reply. Cancellation still runs normal finalizers.
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
  const subagentMs = remainingCleanupMs();
  try {
    await raceWithTimeout(
      () => subagents,
      subagentMs,
      () => {
        throw new Error(`Shutdown subagent settlement did not settle within ${subagentMs}ms`);
      },
      { ref: false },
    );
  } catch (error) {
    shutdownLog.warn(`Subagent settlement failed: ${String(error)}`);
    failure ??= { error };
  }
  // Raw model/tool ownership is resource cleanup, not permission to wait forever.
  const terminalPersistence = sources.flatMap(([, source]) =>
    source.adapter.projectSessionTerminalPersistence
      ? [source.adapter.projectSessionTerminalPersistence]
      : [],
  );
  const released = Promise.allSettled([
    subagents,
    capture.settled,
    interrupted.released,
    ...terminalPersistence,
  ]).then((results) => throwIfSettledRejected(results, "Session shutdown persistence failed"));
  return {
    failure,
    released,
    inspectPending: () => {
      const pending = interrupted.inspectPending();
      return {
        effects: pending.effects,
        phase: pending.phase ?? "none",
        sourcePhase: pending.sourcePhase ?? "none",
        operationPhase: pending.operationPhase ?? "none",
        interrupted: pending.interrupted ?? null,
        settling: pending.settling ?? null,
      };
    },
  };
}
