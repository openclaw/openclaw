import {
  isGatewayNonLoopbackBindMode,
  resolveGatewayPortWithDefault,
} from "../config/gateway-control-ui-origins.js";
import { isLoopbackHost } from "../gateway/net.js";
import { appendCdpPath, normalizeCdpHttpBaseForJsonEndpoints } from "./cdp.helpers.js";

export type BrowserStatusDiagnostic = {
  code:
    | "ATTACH_ONLY_PROFILE"
    | "CONTROL_UI_ALLOWED_ORIGINS_CONFIGURED"
    | "CONTROL_UI_ALLOWED_ORIGINS_REQUIRED"
    | "CONTROL_UI_AUTH_DISABLED"
    | "CONTROL_UI_DISABLED"
    | "CONTROL_UI_HOST_HEADER_FALLBACK"
    | "CONTROL_UI_LOOPBACK_ONLY"
    | "CONTROL_UI_PASSWORD_AUTH"
    | "CONTROL_UI_TOKEN_AUTH"
    | "REMOTE_CDP_HTTP_UNREACHABLE"
    | "REMOTE_CDP_WS_NOT_READY"
    | "LOCAL_CDP_HTTP_UNREACHABLE"
    | "LOCAL_CDP_WS_NOT_READY";
  layer: "control-ui" | "profile" | "cdp";
  level: "info" | "warn" | "danger";
  summary: string;
  hint?: string;
};

type BrowserStatusLike = {
  running: boolean;
  cdpReady?: boolean;
  cdpHttp?: boolean;
  cdpPort: number;
  cdpUrl?: string;
  attachOnly: boolean;
};

type GatewayControlUiStatusLike = {
  gateway?: {
    bind?: unknown;
    port?: unknown;
    auth?: {
      mode?: unknown;
      token?: unknown;
      password?: unknown;
    };
    controlUi?: {
      enabled?: unknown;
      allowedOrigins?: unknown;
      dangerouslyAllowHostHeaderOriginFallback?: unknown;
    };
  };
};

function resolveCdpUrl(status: BrowserStatusLike): string {
  const raw = status.cdpUrl?.trim();
  if (raw) {
    return raw;
  }
  return `http://127.0.0.1:${status.cdpPort}`;
}

function isRemoteCdpUrl(cdpUrl: string): boolean {
  try {
    return !isLoopbackHost(new URL(cdpUrl).hostname);
  } catch {
    return false;
  }
}

function resolveVersionEndpoint(cdpUrl: string): string {
  try {
    return appendCdpPath(normalizeCdpHttpBaseForJsonEndpoints(cdpUrl), "/json/version");
  } catch {
    return `${cdpUrl.replace(/\/$/, "")}/json/version`;
  }
}

export function deriveBrowserStatusDiagnostics(
  status: BrowserStatusLike,
): BrowserStatusDiagnostic[] {
  const diagnostics: BrowserStatusDiagnostic[] = [];
  const cdpUrl = resolveCdpUrl(status);
  const versionEndpoint = resolveVersionEndpoint(cdpUrl);
  const isRemote = isRemoteCdpUrl(cdpUrl);
  const cdpHttp = status.cdpHttp ?? status.running;
  const cdpReady = status.cdpReady ?? status.running;

  if (status.attachOnly) {
    diagnostics.push({
      code: "ATTACH_ONLY_PROFILE",
      layer: "profile",
      level: "info",
      summary:
        "Attach-only profile: OpenClaw will connect to an existing browser instead of launching one.",
      hint: `Expected CDP endpoint: ${versionEndpoint}`,
    });
  }

  if (!cdpHttp) {
    diagnostics.push(
      isRemote
        ? {
            code: "REMOTE_CDP_HTTP_UNREACHABLE",
            layer: "cdp",
            level: "danger",
            summary: `Remote CDP HTTP unreachable at ${versionEndpoint}.`,
            hint: "Check port forwarding, Windows firewall, and the browser bind address.",
          }
        : {
            code: "LOCAL_CDP_HTTP_UNREACHABLE",
            layer: "cdp",
            level: "warn",
            summary: `CDP HTTP unreachable at ${versionEndpoint}.`,
            hint: status.attachOnly
              ? "Make sure the target browser is already running and exposing remote debugging at this address."
              : "Start the selected browser profile, or verify that the active profile points at the expected local relay.",
          },
    );
  } else if (!cdpReady) {
    diagnostics.push(
      isRemote
        ? {
            code: "REMOTE_CDP_WS_NOT_READY",
            layer: "cdp",
            level: "warn",
            summary: "Remote CDP WebSocket is not ready even though HTTP responds.",
            hint: "The browser may be up but not accepting attach sessions yet; retry after startup finishes.",
          }
        : {
            code: "LOCAL_CDP_WS_NOT_READY",
            layer: "cdp",
            level: "warn",
            summary: "CDP HTTP responds but the browser attach session is not ready.",
            hint: status.attachOnly
              ? "Retry after the browser finishes starting, or verify that another client is not holding the profile in a stale state."
              : "Retry after startup finishes, or restart the selected browser profile.",
          },
    );
  }

  return diagnostics;
}

function isConfiguredSecret(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function summarizeOrigins(origins: readonly string[]): string {
  if (origins.length <= 2) {
    return origins.join(", ");
  }
  return `${origins.slice(0, 2).join(", ")} (+${origins.length - 2} more)`;
}

export function deriveGatewayControlUiDiagnostics(
  snapshot: GatewayControlUiStatusLike,
): BrowserStatusDiagnostic[] {
  const diagnostics: BrowserStatusDiagnostic[] = [];
  const gateway = snapshot.gateway ?? {};
  const controlUi = gateway.controlUi ?? {};
  const controlUiEnabled = controlUi.enabled !== false;
  const port = resolveGatewayPortWithDefault(gateway.port);
  const allowedOrigins = normalizeOrigins(controlUi.allowedOrigins);
  const hostHeaderFallback = controlUi.dangerouslyAllowHostHeaderOriginFallback === true;
  const bind = gateway.bind;
  const auth = gateway.auth ?? {};
  const authMode =
    auth.mode === "token" || auth.mode === "password" || auth.mode === "none"
      ? auth.mode
      : undefined;

  if (!controlUiEnabled) {
    diagnostics.push({
      code: "CONTROL_UI_DISABLED",
      layer: "control-ui",
      level: "warn",
      summary: "Control UI is disabled in gateway config.",
      hint: "Enable gateway.controlUi.enabled before debugging browser attach issues in the dashboard.",
    });
    return diagnostics;
  }

  if (isGatewayNonLoopbackBindMode(bind)) {
    if (allowedOrigins.length === 0 && !hostHeaderFallback) {
      diagnostics.push({
        code: "CONTROL_UI_ALLOWED_ORIGINS_REQUIRED",
        layer: "control-ui",
        level: "danger",
        summary: "Non-loopback Control UI access is missing gateway.controlUi.allowedOrigins.",
        hint: `Add the exact dashboard origins you open from Windows/WSL, for example http://localhost:${port}.`,
      });
    } else if (hostHeaderFallback) {
      diagnostics.push({
        code: "CONTROL_UI_HOST_HEADER_FALLBACK",
        layer: "control-ui",
        level: "warn",
        summary: "Control UI origin checks currently rely on Host-header fallback mode.",
        hint: "Prefer explicit gateway.controlUi.allowedOrigins entries so origin/auth failures are easier to diagnose.",
      });
    } else {
      diagnostics.push({
        code: "CONTROL_UI_ALLOWED_ORIGINS_CONFIGURED",
        layer: "control-ui",
        level: "info",
        summary: "Control UI origin allowlist is configured for non-loopback access.",
        hint: `Allowed origins: ${summarizeOrigins(allowedOrigins)}`,
      });
    }
  } else {
    diagnostics.push({
      code: "CONTROL_UI_LOOPBACK_ONLY",
      layer: "control-ui",
      level: "info",
      summary: "Control UI is limited to loopback origins on this gateway.",
      hint: `Open it from http://localhost:${port} or http://127.0.0.1:${port}.`,
    });
  }

  if (authMode === "token") {
    diagnostics.push({
      code: "CONTROL_UI_TOKEN_AUTH",
      layer: "control-ui",
      level: isConfiguredSecret(auth.token) ? "info" : "danger",
      summary: isConfiguredSecret(auth.token)
        ? "Gateway Control UI requires a gateway token."
        : "Gateway auth mode is token, but no token is configured.",
      hint: isConfiguredSecret(auth.token)
        ? "If Control UI reports unauthorized, paste the gateway token into Control UI settings."
        : "Set gateway.auth.token (or OPENCLAW_GATEWAY_TOKEN) before debugging browser reachability.",
    });
  } else if (authMode === "password") {
    diagnostics.push({
      code: "CONTROL_UI_PASSWORD_AUTH",
      layer: "control-ui",
      level: isConfiguredSecret(auth.password) ? "info" : "danger",
      summary: isConfiguredSecret(auth.password)
        ? "Gateway Control UI requires a gateway password."
        : "Gateway auth mode is password, but no password is configured.",
      hint: isConfiguredSecret(auth.password)
        ? "If Control UI reports unauthorized, enter the gateway password in Control UI settings."
        : "Set gateway.auth.password (or OPENCLAW_GATEWAY_PASSWORD) before debugging browser reachability.",
    });
  } else if (authMode === "none") {
    diagnostics.push({
      code: "CONTROL_UI_AUTH_DISABLED",
      layer: "control-ui",
      level: "info",
      summary: "Gateway auth is disabled for Control UI connections.",
      hint: "If the dashboard still fails, the blocker is likely origin policy or browser/CDP reachability instead of token auth.",
    });
  }

  return diagnostics;
}

const diagnosticLayerOrder: Record<BrowserStatusDiagnostic["layer"], number> = {
  "control-ui": 0,
  profile: 1,
  cdp: 2,
};

const diagnosticLevelOrder: Record<BrowserStatusDiagnostic["level"], number> = {
  danger: 0,
  warn: 1,
  info: 2,
};

export function combineBrowserStatusDiagnostics(
  ...groups: ReadonlyArray<readonly BrowserStatusDiagnostic[] | undefined>
): BrowserStatusDiagnostic[] {
  const deduped = new Map<string, BrowserStatusDiagnostic>();
  for (const group of groups) {
    if (!group) {
      continue;
    }
    for (const diagnostic of group) {
      const key = `${diagnostic.code}:${diagnostic.summary}:${diagnostic.hint ?? ""}`;
      if (!deduped.has(key)) {
        deduped.set(key, diagnostic);
      }
    }
  }
  return [...deduped.values()].toSorted((left, right) => {
    const layerCmp = diagnosticLayerOrder[left.layer] - diagnosticLayerOrder[right.layer];
    if (layerCmp !== 0) {
      return layerCmp;
    }
    const levelCmp = diagnosticLevelOrder[left.level] - diagnosticLevelOrder[right.level];
    if (levelCmp !== 0) {
      return levelCmp;
    }
    return left.summary.localeCompare(right.summary);
  });
}
