import { areDiagnosticsEnabledForProcess, emitDiagnosticEvent, } from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "./subsystem.js";
const diag = createSubsystemLogger("diagnostic");
let lastActivityAt = 0;
export const diagnosticLogger = diag;
export function markDiagnosticActivity() {
    lastActivityAt = Date.now();
}
export function getLastDiagnosticActivityAt() {
    return lastActivityAt;
}
export function resetDiagnosticActivityForTest() {
    lastActivityAt = 0;
}
export function logLaneEnqueue(lane, queueSize) {
    if (!areDiagnosticsEnabledForProcess()) {
        return;
    }
    diag.debug(`lane enqueue: lane=${lane} queueSize=${queueSize}`);
    emitDiagnosticEvent({
        type: "queue.lane.enqueue",
        lane,
        queueSize,
    });
    markDiagnosticActivity();
}
export function logLaneDequeue(lane, waitMs, queueSize) {
    if (!areDiagnosticsEnabledForProcess()) {
        return;
    }
    diag.debug(`lane dequeue: lane=${lane} waitMs=${waitMs} queueSize=${queueSize}`);
    emitDiagnosticEvent({
        type: "queue.lane.dequeue",
        lane,
        queueSize,
        waitMs,
    });
    markDiagnosticActivity();
}
