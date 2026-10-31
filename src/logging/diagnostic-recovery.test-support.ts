import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

export function resetDiagnosticRecoveryState() {
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
}
