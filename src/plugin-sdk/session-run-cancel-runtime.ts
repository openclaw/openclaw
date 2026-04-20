// Narrow public seam for the cancel fan-out between delegated tasks (often
// plugin-owned) and the OpenClaw run that owns them. Plugins import this
// subpath to:
//   - register an `onSessionRunCancel` handler tied to a specific session_run
//     target, so core-side aborts notify the delegated task deterministically.
//   - call `requestSessionRunCancel` to ask core to abort the owning run,
//     without importing core internals or branching on specific channels.
//
// The seam is intentionally plugin-neutral: `{ kind: "session_run",
// sessionKey, runId }` is the only target shape.
export {
  emitSessionRunCancel,
  onSessionRunCancel,
  requestSessionRunCancel,
  type RequestSessionRunCancelResult,
  type SessionRunCancelHandler,
  type SessionRunCancelReason,
  type SessionRunCancelTarget,
} from "../sessions/session-run-cancel.js";
