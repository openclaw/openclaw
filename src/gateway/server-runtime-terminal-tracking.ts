import { trackSessionControllerSourceWork } from "../sessions/session-controller.mailbox.js";
import {
  isRpcSourceRegistered,
  retireRpcSource,
  setRpcSourceProjectSessionActive,
  type RpcSourceRef,
} from "../sessions/session-controller.rpc-sources.js";
import { markChatAbortTerminalPersistenceError } from "./chat-abort-lifecycle-internal.js";

/** Retain terminal write custody independently of the source registry's lifetime. */
export function createGatewayTerminalTracking(params: {
  getScopedRpcSource: (runId: string) => RpcSourceRef | undefined;
}) {
  const { getScopedRpcSource } = params;
  const trackedRunIds = (runId: string, clientRunId: string) =>
    runId === clientRunId ? [runId] : [runId, clientRunId];
  const clearTrackedActiveRun = (run: { runId: string; clientRunId: string }) => {
    for (const candidateRunId of trackedRunIds(run.runId, run.clientRunId)) {
      const entry = getScopedRpcSource(candidateRunId);
      if (!entry) {
        continue;
      }
      setRpcSourceProjectSessionActive(entry, false);
    }
  };
  const settleTrackedTerminalEntry = (
    runId: string,
    entry: RpcSourceRef,
    persisted: boolean,
    error?: unknown,
  ) => {
    entry.adapter.projectSessionTerminalPending = false;
    entry.adapter.projectSessionTerminalPersistence = undefined;
    entry.adapter.projectSessionTerminalPersisted = persisted;
    markChatAbortTerminalPersistenceError(entry, error);
    if (isRpcSourceRegistered(entry) && entry.input.retirementRequested) {
      retireRpcSource(runId, entry);
    }
  };
  const settleTrackedTerminal = (run: { runId: string; clientRunId: string }) => {
    for (const candidateRunId of trackedRunIds(run.runId, run.clientRunId)) {
      const entry = getScopedRpcSource(candidateRunId);
      if (entry && !entry.adapter.projectSessionTerminalPersistence) {
        settleTrackedTerminalEntry(candidateRunId, entry, false);
      }
    }
  };
  const trackedTerminalWrites = new WeakSet<Promise<void>>();
  const trackTrackedRunTerminalPersistence = (run: {
    runId: string;
    clientRunId: string;
    persistence: Promise<void>;
  }) => {
    // Ingress and the lazy chat consumer adopt the same prepared write once.
    if (trackedTerminalWrites.has(run.persistence)) {
      return true;
    }
    let tracked = false;
    for (const candidateRunId of trackedRunIds(run.runId, run.clientRunId)) {
      const entry = getScopedRpcSource(candidateRunId);
      if (!entry) {
        continue;
      }
      tracked = true;
      entry.adapter.projectSessionTerminalPersisted = false;
      markChatAbortTerminalPersistenceError(entry, undefined);
      entry.adapter.projectSessionTerminalPersistence = run.persistence;
      trackSessionControllerSourceWork(entry.input, run.persistence);
      const settle = (persisted: boolean, error?: unknown) => {
        if (entry.adapter.projectSessionTerminalPersistence !== run.persistence) {
          return;
        }
        // Captured drain targets still need final facts after registry retirement.
        settleTrackedTerminalEntry(candidateRunId, entry, persisted, error);
      };
      void run.persistence.then(
        () => settle(true),
        (error: unknown) => settle(false, error),
      );
    }
    if (tracked) {
      trackedTerminalWrites.add(run.persistence);
    }
    return tracked;
  };
  return {
    trackedRunIds,
    clearTrackedActiveRun,
    settleTrackedTerminal,
    settleTrackedTerminalEntry,
    trackTrackedRunTerminalPersistence,
  };
}
