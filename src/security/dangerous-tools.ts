// Shared tool-risk constants.
// Keep these centralized so gateway HTTP restrictions and security audits don't drift.

/**
 * Tools denied via Gateway HTTP `POST /tools/invoke` by default.
 * These are high-risk because they enable session orchestration, control-plane actions,
 * or interactive flows that don't make sense over a non-interactive HTTP surface.
 */
export const DEFAULT_GATEWAY_HTTP_TOOL_DENY = [
  // Direct command execution — immediate RCE surface
  "exec",
  // Arbitrary child process creation — immediate RCE surface
  "spawn",
  // Shell command execution — immediate RCE surface
  "shell",
  // Canonical workspace write tool — arbitrary file mutation on the host;
  // opt-in via BOTH `gateway.tools.allow: ["write"]` AND
  // `gateway.tools.directInvoke.hostFsWrite: true`.
  "write",
  // Canonical workspace edit tool — arbitrary file mutation on the host;
  // opt-in via BOTH `gateway.tools.allow: ["edit"]` AND
  // `gateway.tools.directInvoke.hostFsWrite: true`.
  "edit",
  // Arbitrary file mutation on the host (legacy/alternate name)
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
  // Gateway control plane — prevents gateway reconfiguration via HTTP
  "gateway",
  // Node command relay can reach system.run on paired hosts
  "nodes",
  // Host filesystem read — opt-in via BOTH `gateway.tools.allow: ["read"]` AND
  // `gateway.tools.directInvoke.hostFsRead: true`. The default-deny prevents
  // an upgrade-time compatibility break where pre-existing `allow: ["read"]`
  // entries (kept around for non-direct-invoke surfaces) would silently grant
  // host-FS read here. See `tool-resolution.ts` dual-key gating.
  "read",
] as const;

/**
 * Subset of {@link DEFAULT_GATEWAY_HTTP_TOOL_DENY} whose default-deny exists to
 * gate the BUILT-IN host-FS coding tool (`read`/`write`/`edit`, materialized
 * behind `gateway.tools.directInvoke.hostFsRead`/`hostFsWrite`) — NOT to block a
 * same-named tool from another source. These names commonly collide with plugin
 * tool names, so a plugin tool an operator has allowlisted must stay reachable on
 * `/tools/invoke` + SDK `tools.invoke`; only the built-in is gated. The resolver
 * (`tool-resolution.ts`, final gateway deny filter) preserves a same-named plugin
 * tool when its sole deny reason is this default — the built-in stays denied.
 */
export const HOST_FS_BUILTIN_CODING_DENY_NAMES = ["read", "write", "edit"] as const;

/**
 * Core tools that require sender owner identity on Gateway-scoped surfaces.
 * `gateway.tools.allow` can remove the default HTTP deny only for owner/trusted-operator
 * callers; non-owner identity-bearing callers must not receive server-credential wrappers.
 */
export const GATEWAY_OWNER_ONLY_CORE_TOOLS = ["cron", "gateway", "nodes"] as const;
