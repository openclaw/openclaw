import { afterEach, beforeEach, vi } from "vitest";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { emitChildProcessSpawnSample } from "./spawn-diagnostics.js";

export function useSpawnDiagnostics() {
  const events: DiagnosticEventPayload[] = [];
  let now = 0;
  let stop: () => void;
  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    resetDiagnosticEventsForTest();
    setDiagnosticsEnabledForProcess(false);
    emitChildProcessSpawnSample();
    setDiagnosticsEnabledForProcess(true);
    events.length = 0;
    stop = onDiagnosticEvent((event) => {
      if (event.type === "diagnostic.child_process.spawn") {
        events.push(event);
      }
    });
  });
  afterEach(() => {
    stop();
    setDiagnosticsEnabledForProcess(false);
    emitChildProcessSpawnSample();
    resetDiagnosticEventsForTest();
    vi.restoreAllMocks();
  });
  return {
    events,
    sampleAt(time: number) {
      now = time;
      emitChildProcessSpawnSample();
    },
  };
}
