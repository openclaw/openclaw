import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
// Shared tool-risk constants.
// Keep these centralized so gateway HTTP restrictions and security audits don't drift.
import { roleScopesAllow } from "../shared/operator-scope-compat.js";

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
  // Shared terminal input can execute commands and scrollback can expose host secrets.
  "terminal",
  // Local HTTP exposure can publish arbitrary workspace applications.
  "portal",
  // Session orchestration — spawning agents remotely is RCE
  "sessions_spawn",
  // Cross-session injection — message injection across sessions
  "sessions_send",
  // External conversation discovery and delivery use server-held channel credentials
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  // Persistent automation control plane — can create/update/remove scheduled runs
  AUTOMATIONS_TOOL_NAME,
  // Gateway config can expose secrets and host topology
  "gateway",
  "plugins",
  // Node command relay can reach system.run on paired hosts
  "nodes",
  // Desktop control on a paired Mac (pointer/keyboard) and screen reads
  "computer",
  // Android AccessibilityService reads and cross-app UI control
  "mobile_ui",
  "openclaw",
] as const;

/**
 * Sensitive control-plane tools. `automations` can persist scheduled runs; `gateway`
 * exposes config and self-update; `plugins` manages executable plugin lifecycles.
 */
export const GATEWAY_CONTROL_PLANE_TOOLS = [AUTOMATIONS_TOOL_NAME, "gateway", "plugins"] as const;

/**
 * Core tools that require owner-level authority on Gateway-scoped surfaces.
 * A live admitted admin retains interactive owner-tool eligibility without
 * changing sender attribution; standing intents still require explicit identity.
 * `gateway.tools.allow` can remove the default HTTP deny only for owner/trusted-operator
 * callers; non-owner identity-bearing callers must not receive server-credential wrappers.
 */
export const GATEWAY_OWNER_ONLY_CORE_TOOLS = [
  ...GATEWAY_CONTROL_PLANE_TOOLS,
  "sessions",
  "screen",
  "terminal",
  "portal",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
  "nodes",
  "computer",
  "mobile_ui",
  "openclaw",
  "intent",
] as const;

const gatewayOwnerOnlyCoreToolNames = new Set<string>(GATEWAY_OWNER_ONLY_CORE_TOOLS);
// Retained operator custody covers these control-plane paths, not every
// owner-only executor. Other tools keep their sender or scoped admission.
const retainedOperatorToolNames = new Set<string>(GATEWAY_CONTROL_PLANE_TOOLS);

function isGatewayOwnerOnlyCoreTool(toolName: string): boolean {
  return gatewayOwnerOnlyCoreToolNames.has(toolName);
}

/** Live admin is owner-tool eligible, as at interactive agent admission; it is not sender identity. */
export function hasGatewayOwnerToolAuthority(
  senderIsOwner: boolean | undefined,
  operatorAuthority?: AdmittedRunOperatorAuthority,
  turnTainted = false,
): boolean {
  // Network content limits inherited custody, not an explicit owner's live authority.
  if (turnTainted && senderIsOwner !== true) {
    return false;
  }
  if (operatorAuthority) {
    operatorAuthority.assertCurrent();
    return roleScopesAllow({
      role: "operator",
      requestedScopes: ["operator.admin"],
      allowedScopes: operatorAuthority.scopes,
    });
  }
  return senderIsOwner === true;
}

export function assertGatewayOwnerToolAuthority(
  toolName: string,
  senderIsOwner: boolean | undefined,
  operatorAuthority: AdmittedRunOperatorAuthority,
  turnTainted = false,
): void {
  if (!isGatewayOwnerOnlyCoreTool(toolName)) {
    return;
  }
  if (
    !hasGatewayOwnerToolAuthority(senderIsOwner, operatorAuthority, turnTainted) ||
    (senderIsOwner !== true && !retainedOperatorToolNames.has(toolName))
  ) {
    throw new Error(
      turnTainted && senderIsOwner !== true
        ? "Owner-level tools cannot run on a tainted turn."
        : `${toolName} requires current owner-level tool authority.`,
    );
  }
}

export function resolveGatewayOwnerOnlyToolDenylist(
  senderIsOwner?: boolean,
  operatorAuthority?: AdmittedRunOperatorAuthority,
  turnTainted = false,
): string[] {
  if (operatorAuthority) {
    const eligible = hasGatewayOwnerToolAuthority(senderIsOwner, operatorAuthority, turnTainted);
    return GATEWAY_OWNER_ONLY_CORE_TOOLS.filter(
      (name) => !eligible || (senderIsOwner !== true && !retainedOperatorToolNames.has(name)),
    );
  }
  // Standing intents always require explicit owner identity, including on internal turns.
  return GATEWAY_OWNER_ONLY_CORE_TOOLS.filter(
    (name) => senderIsOwner !== true && (senderIsOwner === false || name === "intent"),
  );
}
