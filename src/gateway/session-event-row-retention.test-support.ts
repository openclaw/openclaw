import { setImmediate } from "node:timers/promises";
import { onTestFinished } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";

export function observeSessionEventRowRetention() {
  const wasEnabled = areDiagnosticsEnabledForProcess();
  setDiagnosticsEnabledForProcess(true);
  let retention: { entries: number; estimatedBytes: number } | undefined;
  const unsubscribe = onInternalDiagnosticEvent(
    (event, metadata) => {
      if (metadata.trusted && event.type === "sessions.event.retention") {
        retention = { entries: event.entries, estimatedBytes: event.estimatedBytes };
      }
    },
    { include: ["sessions.event.retention"], includeTrusted: ["sessions.event.retention"] },
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
