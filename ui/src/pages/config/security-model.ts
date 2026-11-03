import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";

type ExecSecurity = "deny" | "allowlist" | "full";
type ExecAsk = "off" | "on-miss" | "always";
export type ExecApprovalDefaults = { security: string; ask: string };

/** What config asks for. Startup flags can override it, so it never proves where the Gateway listens. */
export type GatewayNetworkAccess =
  | { kind: "unknown" | "default" | "loopback" | "lan" | "tailnet" | "auto" | "serve" | "funnel" }
  | { kind: "custom" | "via"; host: string };

/** What the running Gateway reports, which outranks what its config file says. */
export type SecurityLiveFacts = {
  configLoaded?: boolean;
  authMode?: string | null;
  /** Host of the URL this browser reached the Gateway through. */
  connectedHost?: string | null;
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

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveGatewayAuth(root: Record<string, unknown>, live: SecurityLiveFacts): string {
  if (live.authMode) {
    return live.authMode;
  }
  // Without a live answer only an explicit mode is known: env can still supply a credential.
  const auth = asConfigRecord(asConfigRecord(root.gateway)?.auth);
  const mode = readString(auth?.mode);
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

function resolveNetworkAccess(
  root: Record<string, unknown>,
  live: SecurityLiveFacts,
): GatewayNetworkAccess {
  if (live.configLoaded === false) {
    return { kind: "unknown" };
  }
  const gateway = asConfigRecord(root.gateway);
  const tailscale = readString(asConfigRecord(gateway?.tailscale)?.mode);
  if (tailscale === "funnel" || tailscale === "serve") {
    return { kind: tailscale };
  }
  const bind = readString(gateway?.bind);
  if (bind === "custom") {
    const host = readString(gateway?.customBindHost);
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
  const mode = readString(exec.mode);
  const modePolicy = EXEC_MODE_POLICIES[mode];
  if (mode && !modePolicy) {
    return mode;
  }
  const security = (modePolicy?.security ??
    (readString(exec.security) || REQUESTED_EXEC_DEFAULTS.security)) as ExecSecurity;
  const ask = (modePolicy?.ask ?? (readString(exec.ask) || REQUESTED_EXEC_DEFAULTS.ask)) as ExecAsk;
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
    networkAccess: resolveNetworkAccess(root, live),
    execPolicy: resolveExecPolicy(root, live),
    browserEnabled: browser?.enabled !== false,
    toolProfile: typeof profile === "string" ? profile.trim() : "",
  };
}
