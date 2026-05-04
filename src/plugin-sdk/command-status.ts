export {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
} from "../auto-reply/command-status-builders.js";
export type {
  CommandsMessageOptions,
  CommandsMessageResult,
} from "../auto-reply/command-status-builders.js";
// Status payload types — exported so plugins consuming gateway status RPCs
// (or formatting `/status` output) can bind against the canonical host shape
// rather than redeclare it and drift on host upgrades. See #76759.
export type { HeartbeatStatus, SessionStatus, StatusSummary } from "../commands/status.types.js";
