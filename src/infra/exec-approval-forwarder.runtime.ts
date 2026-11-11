// Lazy runtime imports keep approval forwarding testable without eagerly loading
// channel delivery code.
export { resolveExecApprovalSessionTargetAsync } from "./exec-approval-session-target.js";
export { sendDurableMessageBatchCore } from "../channels/message/runtime.js";
