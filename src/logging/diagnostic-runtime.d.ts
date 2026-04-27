export declare const diagnosticLogger: import("./subsystem.js").SubsystemLogger;
export declare function markDiagnosticActivity(): void;
export declare function getLastDiagnosticActivityAt(): number;
export declare function resetDiagnosticActivityForTest(): void;
export declare function logLaneEnqueue(lane: string, queueSize: number): void;
export declare function logLaneDequeue(lane: string, waitMs: number, queueSize: number): void;
