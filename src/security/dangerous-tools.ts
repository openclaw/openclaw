// Shared tool-risk constants.
// Keep these centralized so gateway restrictions and security audits don't drift.

/**
 * Tools denied on ALL gateway surfaces (HTTP, MCP, etc.) by default.
 * These are universally dangerous — RCE primitives, arbitrary file mutation,
 * session orchestration, and control-plane actions.
 */
export const DEFAULT_GATEWAY_TOOL_DENY = [
  // Direct command execution — immediate RCE surface
  "exec",
  // Arbitrary child process creation — immediate RCE surface
  "spawn",
  // Shell command execution — immediate RCE surface
  "shell",
  // Arbitrary file mutation on the host
  "fs_write",
  // Arbitrary file deletion on the host
  "fs_delete",
  // Arbitrary file move/rename on the host
  "fs_move",
  // Patch application can rewrite arbitrary files
  "apply_patch",
  // Session orchestration — spawning agents remotely is RCE
  "sessions_spawn",
  // Cross-session injection — message injection across sessions
  "sessions_send",
  // Persistent automation control plane — can create/update/remove scheduled runs
  "cron",
  // Gateway control plane — prevents gateway reconfiguration
  "gateway",
  // Node command relay can reach system.run on paired hosts
  "nodes",
] as const;

/**
 * Tools denied only on the HTTP gateway surface due to HTTP-specific constraints.
 * These are not inherently dangerous but don't work over non-interactive HTTP
 * (e.g. interactive terminal flows). MCP clients can handle these.
 */
export const DEFAULT_GATEWAY_HTTP_ONLY_TOOL_DENY = [
  // Interactive setup — requires terminal QR scan, hangs on HTTP
  "whatsapp_login",
] as const;

/**
 * Combined deny list for the HTTP gateway surface.
 * Union of universal + HTTP-only denials. Used by `POST /tools/invoke`.
 */
export const DEFAULT_GATEWAY_HTTP_TOOL_DENY = [
  ...DEFAULT_GATEWAY_TOOL_DENY,
  ...DEFAULT_GATEWAY_HTTP_ONLY_TOOL_DENY,
] as const;
