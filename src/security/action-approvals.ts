/**
 * Extended Action Approvals
 *
 * Maps tool calls to approval categories and provides logic for
 * determining which actions require explicit user approval.
 *
 * Addresses: T-EXFIL-001 (P1), T-EXFIL-002, T-IMPACT-001 (P1)
 */

export type ApprovalCategory = "exec" | "network" | "messaging" | "config" | "data-access";

export type ApprovalDecision = {
  requiresApproval: boolean;
  category: ApprovalCategory;
  reason?: string;
};

/**
 * Domain allowlist for network tools that don't require approval.
 */
const DEFAULT_NETWORK_ALLOWLIST = new Set([
  "docs.openclaw.ai",
  "clawhub.com",
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "stackoverflow.com",
  "developer.mozilla.org",
]);

/**
 * Map a tool name + params to an approval category.
 */
export function categorizeToolCall(
  toolName: string,
  params?: Record<string, unknown>,
): ApprovalCategory | null {
  const lower = toolName.toLowerCase();

  // Network tools
  if (lower === "web_fetch" || lower === "web_search") {
    return "network";
  }

  // Messaging tools
  if (lower === "message" || lower === "sessions_send") {
    return "messaging";
  }

  // Config/gateway tools
  if (lower === "gateway") {
    const action = (typeof params?.action === "string" ? params.action : "").toLowerCase();
    if (action === "config.apply" || action === "update.run") {
      return "config";
    }
    return null; // Read-only gateway actions don't need approval
  }

  // Exec tools are handled by the existing exec approval system
  if (lower === "exec" || lower === "process") {
    return "exec";
  }

  return null;
}

/**
 * Check if a network request is to an allowlisted domain.
 */
export function isAllowlistedDomain(url: string, allowlist?: Set<string>): boolean {
  const domains = allowlist ?? DEFAULT_NETWORK_ALLOWLIST;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return domains.has(hostname) || Array.from(domains).some((d) => hostname.endsWith("." + d));
  } catch {
    return false;
  }
}

/**
 * Evaluate whether a tool call requires approval.
 */
export function evaluateApproval(
  toolName: string,
  params?: Record<string, unknown>,
  opts?: {
    networkAllowlist?: Set<string>;
    knownRecipients?: Set<string>;
  },
): ApprovalDecision | null {
  const category = categorizeToolCall(toolName, params);
  if (!category) {
    return null;
  }

  // Network: only require approval for non-allowlisted domains
  if (category === "network") {
    const url =
      typeof params?.url === "string"
        ? params.url
        : typeof params?.query === "string"
          ? params.query
          : "";
    if (url && isAllowlistedDomain(url, opts?.networkAllowlist)) {
      return { requiresApproval: false, category };
    }
    return {
      requiresApproval: true,
      category,
      reason: `Network request to external domain`,
    };
  }

  // Messaging: only require approval for new recipients
  if (category === "messaging") {
    const to =
      typeof params?.to === "string"
        ? params.to
        : typeof params?.sessionKey === "string"
          ? params.sessionKey
          : "";
    if (to && opts?.knownRecipients?.has(to)) {
      return { requiresApproval: false, category };
    }
    return {
      requiresApproval: true,
      category,
      reason: `Message to ${to ? "unknown recipient" : "unspecified recipient"}`,
    };
  }

  // Config: always requires approval
  if (category === "config") {
    return {
      requiresApproval: true,
      category,
      reason: `Configuration change: ${typeof params?.action === "string" ? params.action : "unknown"}`,
    };
  }

  // Exec: defer to existing exec approval system
  if (category === "exec") {
    return null;
  }

  return null;
}
