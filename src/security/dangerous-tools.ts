// Shared tool-risk constants.
// Keep these centralized so gateway HTTP restrictions, security audits, and ACP prompts don't drift.

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
	// Gateway control plane — prevents gateway reconfiguration via HTTP
	"gateway",
	// Node command relay can reach system.run on paired hosts
	"nodes",
	// Interactive setup — requires terminal QR scan, hangs on HTTP
	"whatsapp_login",
] as const;

/**
 * ACP tools that should always require explicit user approval.
 * ACP is an automation surface; we never want "silent yes" for mutating/execution tools.
 */
export const DANGEROUS_ACP_TOOL_NAMES = [
	"exec",
	"spawn",
	"shell",
	"sessions_spawn",
	"sessions_send",
	"gateway",
	"fs_write",
	"fs_delete",
	"fs_move",
	"apply_patch",
] as const;

export const DANGEROUS_ACP_TOOLS = new Set<string>(DANGEROUS_ACP_TOOL_NAMES);
