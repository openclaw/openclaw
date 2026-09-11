// Plugin SDK surface for live local session sources: a plugin adapts one native
// harness (Codex daemon, Claude Code transcripts) on a paired device, and the
// Gateway bridge projects those sessions for the team over the node duplex.
export {
  createLocalSessionSourceNodeCommand,
  type LocalSessionSourceDefinition,
  type LocalSessionSourceHost,
  type LocalSessionSourceSession,
  type LocalSessionSourceStartOptions,
} from "../node-host/local-session-source-command.js";
export {
  clipLocalSessionRecordText,
  formatLocalSessionInputEnvelope,
  LOCAL_SESSION_BOOTSTRAP_MAX_BYTES,
  LOCAL_SESSION_BOOTSTRAP_MAX_RECORDS,
  type LocalSessionGatewayInputFrame,
  type LocalSessionRecord,
  type LocalSessionThreadState,
} from "../sessions/local-session-source-protocol.js";
