import type { Snapshot } from "@openclaw/gateway-protocol";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

type ExecSecurity = "deny" | "allowlist" | "full";
type ExecAsk = "off" | "on-miss" | "always";
export type ExecApprovalDefaults = { security: string; ask: string };

/**
 * Plain kinds repeat what config asks for, which startup flags can override.
 * Only `reported*` kinds come from the running Gateway, so only they can reassure.
 */
export type GatewayNetworkAccess =
  | {
      kind:
        | "unknown"
        | "default"
        | "loopback"
        | "lan"
        | "tailnet"
        | "auto"
        | "serve"
        | "funnel"
        | "reportedLoopback"
        | "reportedAllInterfaces"
        | "reportedServe"
        | "reportedFunnel";
    }
  | { kind: "custom" | "via" | "reportedTailnet" | "reportedHost"; host: string };

/** What the running Gateway reports, which outranks what its config file says. */
export type SecurityLiveFacts = {
  configLoaded?: boolean;
  authMode?: string | null;
  /** Host of the URL this browser reached the Gateway through. */
  connectedHost?: string | null;
  /** Older Gateways report neither of these. */
  bindHost?: string | null;
  tailscaleMode?: string | null;
  tailscaleExposure?: Snapshot["tailscaleExposure"];
  execApprovalDefaults?: ExecApprovalDefaults | null;
};

const EXEC_SECURITY_ORDER: readonly ExecSecurity[] = ["deny", "allowlist", "full"];
const EXEC_ASK_ORDER: readonly ExecAsk[] = ["off", "on-miss", "always"];
// Matches the Gateway's requested policy when tools.exec is unset.
const REQUESTED_EXEC_DEFAULTS = { security: "full", ask: "off" } as const;

const EXEC_MODE_POLICIES: Record<string, { security: ExecSecurity; ask: ExecAsk }> = {
  deny: { security: "deny", ask: "off" },
  allowlist: { security: "allowlist", ask: "off" },
  ask: { security: "allowlist", ask: "on-miss" },
  auto: { security: "allowlist", ask: "on-miss" },
  full: { security: "full", ask: "off" },
};

function resolveGatewayAuth(root: Record<string, unknown>, live: SecurityLiveFacts): string {
  if (live.authMode) {
    return live.authMode;
  }
  // Without a live answer only an explicit mode is known: env can still supply a credential.
  const auth = asConfigRecord(asConfigRecord(root.gateway)?.auth);
  const mode = normalizeOptionalString(auth?.mode);
  if (mode) {
    return mode;
  }
  return auth?.password
    ? "password"
    : auth?.token
      ? "token"
      : auth?.trustedProxy
        ? "trusted-proxy"
        : "unknown";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.") ||
    normalized.endsWith(".localhost")
  );
}

function isTailnetAddress(host: string): boolean {
  return (
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    host.toLowerCase().startsWith("fd7a:115c:a1e0:")
  );
}

function resolveReportedNetworkAccess(
  bindHost: string,
  tailscaleMode: string,
  connectedHost?: string | null,
): GatewayNetworkAccess {
  if (tailscaleMode === "funnel") {
    return { kind: "reportedFunnel" };
  }
  if (tailscaleMode === "serve") {
    return { kind: "reportedServe" };
  }
  if (isLoopbackHost(bindHost)) {
    // Listening on loopback says nothing about a proxy or tunnel this browser came through.
    const host = connectedHost?.trim();
    return host && !isLoopbackHost(host) ? { kind: "via", host } : { kind: "reportedLoopback" };
  }
  if (bindHost === "0.0.0.0" || bindHost === "::") {
    return { kind: "reportedAllInterfaces" };
  }
  return { kind: isTailnetAddress(bindHost) ? "reportedTailnet" : "reportedHost", host: bindHost };
}

function resolveNetworkAccess(
  root: Record<string, unknown>,
  live: SecurityLiveFacts,
): GatewayNetworkAccess {
  // Both or neither: a bind alone can't rule out Tailscale exposure on top of loopback.
  if (live.bindHost && live.tailscaleMode) {
    return resolveReportedNetworkAccess(live.bindHost, live.tailscaleMode, live.connectedHost);
  }
  if (live.configLoaded === false) {
    return { kind: "unknown" };
  }
  const gateway = asConfigRecord(root.gateway);
  const tailscale = normalizeOptionalString(asConfigRecord(gateway?.tailscale)?.mode);
  if (tailscale === "funnel" || tailscale === "serve") {
    return { kind: tailscale };
  }
  const bind = normalizeOptionalString(gateway?.bind);
  if (bind === "custom") {
    const host = normalizeOptionalString(gateway?.customBindHost);
    return host ? { kind: "custom", host } : { kind: "auto" };
  }
  if (bind === "lan" || bind === "tailnet" || bind === "auto") {
    return { kind: bind };
  }
  // A loopback Gateway reached from another host sits behind a proxy or a command-line bind.
  const connectedHost = live.connectedHost?.trim();
  if (connectedHost && !isLoopbackHost(connectedHost)) {
    return { kind: "via", host: connectedHost };
  }
  return { kind: bind === "loopback" ? "loopback" : "default" };
}

function stricterOf<T extends string>(order: readonly T[], left: T, right: string): T {
  const rightIndex = order.indexOf(right as T);
  return rightIndex >= 0 && rightIndex < order.indexOf(left) ? (right as T) : left;
}

function widerAskOf(left: ExecAsk, right: string): ExecAsk {
  const rightIndex = EXEC_ASK_ORDER.indexOf(right as ExecAsk);
  return rightIndex > EXEC_ASK_ORDER.indexOf(left) ? (right as ExecAsk) : left;
}

/** The requested tools.exec policy intersected with host approvals, as the Gateway enforces it. */
function resolveExecPolicy(root: Record<string, unknown>, live: SecurityLiveFacts): string {
  if (live.configLoaded === false || !live.execApprovalDefaults) {
    return "unknown";
  }
  const exec = asConfigRecord(asConfigRecord(root.tools)?.exec) ?? {};
  const mode = normalizeOptionalString(exec.mode) ?? "";
  const modePolicy = EXEC_MODE_POLICIES[mode];
  if (mode && !modePolicy) {
    return mode;
  }
  const security = (modePolicy?.security ??
    (normalizeOptionalString(exec.security) || REQUESTED_EXEC_DEFAULTS.security)) as ExecSecurity;
  const ask = (modePolicy?.ask ??
    (normalizeOptionalString(exec.ask) || REQUESTED_EXEC_DEFAULTS.ask)) as ExecAsk;
  const effectiveSecurity = stricterOf(
    EXEC_SECURITY_ORDER,
    security,
    live.execApprovalDefaults.security,
  );
  const effectiveAsk = widerAskOf(ask, live.execApprovalDefaults.ask);
  if (mode && effectiveSecurity === security && effectiveAsk === ask) {
    return mode;
  }
  if (effectiveSecurity === "deny") {
    return "deny";
  }
  if (effectiveSecurity === "allowlist" && effectiveAsk === "off") {
    return "allowlist";
  }
  if (effectiveSecurity === "full" && effectiveAsk !== "always") {
    return "full";
  }
  return EXEC_SECURITY_ORDER.includes(effectiveSecurity) ? "ask" : effectiveSecurity;
}

export function extractQuickSettingsSecurity(
  root: Record<string, unknown>,
  live: SecurityLiveFacts = {},
) {
  const tools = asConfigRecord(root.tools);
  const browser = asConfigRecord(root.browser);
  const profile = tools?.profile;
  return {
    gatewayAuth: resolveGatewayAuth(root, live),
    // Gateways that report their exposure also report the auth connections are checked against.
    gatewayAuthReported: Boolean(live.authMode && live.bindHost && live.tailscaleMode),
    networkAccess: resolveNetworkAccess(root, live),
    ...(live.tailscaleExposure ? { tailscaleExposure: live.tailscaleExposure } : {}),
    execPolicy: resolveExecPolicy(root, live),
    browserEnabled: browser?.enabled !== false,
    toolProfile: typeof profile === "string" ? profile.trim() : "",
  };
}
