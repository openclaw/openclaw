import { sanitizeDiagnosticPayload } from "../agents/payload-redaction.js";
import { TRAJECTORY_RUNTIME_EVENT_MAX_BYTES } from "./paths.js";

// Capture keeps every object that fits one event. The shared diagnostic
// projector defaults to 64 objects, which drops later fields such as tool
// catalogs and replaces them with "[Truncated]".
const TRAJECTORY_EXPORT_MAX_NODES = TRAJECTORY_RUNTIME_EVENT_MAX_BYTES / 2;

export function sanitizeTrajectoryExportPayload(value: unknown): unknown {
  return sanitizeDiagnosticPayload(value, { maxNodes: TRAJECTORY_EXPORT_MAX_NODES });
}
