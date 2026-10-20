import { setImmediate } from "node:timers/promises";
import { onTestFinished } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import type { SessionEventRowsResetCause } from "../infra/diagnostic-rpc-types.js";

export function observeSessionEventRowRetention(
  onReset?: (event: { cause: SessionEventRowsResetCause; count: number }) => void,
) {
  const wasEnabled = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(true);
  let retention: { entries: number; estimatedBytes: number } | undefined;
  const unsubscribe = onInternalDiagnosticEvent(
    (event, metadata) => {
      if (metadata.trusted && event.type === "sessions.event.retention") {
        retention = { entries: event.entries, estimatedBytes: event.estimatedBytes };
      } else if (metadata.trusted && event.type === "sessions.event.rows.reset") {
        onReset?.(event);
      }
    },
    {
      include: ["sessions.event.retention", "sessions.event.rows.reset"],
      includeTrusted: ["sessions.event.retention", "sessions.event.rows.reset"],
    },
  );
  onTestFinished(() => {
    unsubscribe();
    setDiagnosticsEnabledForProcess(wasEnabled);
  });
  return async () => {
    // The owner coalesces charges before the diagnostic dispatcher queues its event.
    await setImmediate();
    await waitForDiagnosticEventsDrained();
    if (!retention) {
      throw new Error("Expected a session-event row retention diagnostic");
    }
    return retention;
  };
}
