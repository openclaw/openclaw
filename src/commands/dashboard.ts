import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayAuthToken } from "../gateway/auth-token-resolution.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { copyToClipboard } from "../infra/clipboard.js";
import { resolveTailscaleClient } from "../infra/tailscale.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  resolveControlUiLinks,
} from "./onboard-helpers.js";

type DashboardOptions = {
  noOpen?: boolean;
};

function formatDashboardLinksFromHost(params: {
  host: string;
  basePath?: string;
  secure: boolean;
}): { httpUrl: string; wsUrl: string } {
  const basePath = normalizeControlUiBasePath(params.basePath);
  const uiPath = basePath ? `${basePath}/` : "/";
  const wsPath = basePath ? basePath : "";
  const httpScheme = params.secure ? "https" : "http";
  const wsScheme = params.secure ? "wss" : "ws";
  return {
    httpUrl: `${httpScheme}://${params.host}${uiPath}`,
    wsUrl: `${wsScheme}://${params.host}${wsPath}`,
  };
}

async function resolveDashboardLinks(params: {
  cfg: OpenClawConfig;
  port: number;
  bind: "auto" | "lan" | "loopback" | "custom" | "tailnet";
  customBindHost?: string;
  basePath?: string;
  runtime: RuntimeEnv;
}): Promise<{ httpUrl: string; wsUrl: string }> {
  const tailscaleMode = params.cfg.gateway?.tailscale?.mode ?? "off";
  if (tailscaleMode === "serve" || tailscaleMode === "funnel") {
    try {
      const client = await resolveTailscaleClient(undefined, {
        binaryPath: params.cfg.gateway?.tailscale?.binaryPath,
        socketPath: params.cfg.gateway?.tailscale?.socketPath,
      });
      const host = client.dnsName ?? client.ips[0];
      if (host) {
        return formatDashboardLinksFromHost({
          host,
          basePath: params.basePath,
          secure: true,
        });
      }
      params.runtime.log(
        "Tailscale dashboard URL unavailable: Tailscale is running but did not report a DNS name or IP; falling back to loopback URL.",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      params.runtime.log(
        `Tailscale dashboard URL unavailable: ${message}; falling back to loopback URL.`,
      );
    }
  }

  return resolveControlUiLinks({
    port: params.port,
    bind: params.bind,
    customBindHost: params.customBindHost,
    basePath: params.basePath,
    tlsEnabled: params.cfg.gateway?.tls?.enabled === true,
  });
}

export async function dashboardCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DashboardOptions = {},
) {
  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : {};
  const port = resolveGatewayPort(cfg);
  const bind = cfg.gateway?.bind ?? "loopback";
  const basePath = cfg.gateway?.controlUi?.basePath;
  const customBindHost = cfg.gateway?.customBindHost;
  const resolvedToken = await resolveGatewayAuthToken({
    cfg,
    env: process.env,
    envFallback: "always",
  });
  const token = resolvedToken.token ?? "";

  // LAN URLs fail secure-context checks in browsers.
  // Coerce only lan->loopback and preserve other bind modes.
  const links = await resolveDashboardLinks({
    cfg,
    port,
    bind: bind === "lan" ? "loopback" : bind,
    customBindHost,
    basePath,
    runtime,
  });
  // Avoid embedding externally managed SecretRef tokens in terminal/clipboard/browser args.
  const includeTokenInUrl = token.length > 0 && !resolvedToken.secretRefConfigured;
  // Prefer URL fragment to avoid leaking auth tokens via query params.
  const dashboardUrl = includeTokenInUrl
    ? `${links.httpUrl}#token=${encodeURIComponent(token)}`
    : links.httpUrl;

  runtime.log(`Dashboard URL: ${links.httpUrl}`);
  if (includeTokenInUrl) {
    runtime.log("Token auto-auth included in browser/clipboard URL.");
  }
  if (resolvedToken.secretRefConfigured && token) {
    runtime.log(
      "Token auto-auth is disabled for SecretRef-managed gateway.auth.token; use your external token source if prompted.",
    );
  }
  if (resolvedToken.unresolvedRefReason) {
    runtime.log(`Token auto-auth unavailable: ${resolvedToken.unresolvedRefReason}`);
    runtime.log(
      "Set OPENCLAW_GATEWAY_TOKEN in this shell or resolve your secret provider, then rerun `openclaw dashboard`.",
    );
  }

  const copied = await copyToClipboard(dashboardUrl).catch(() => false);
  runtime.log(copied ? "Copied to clipboard." : "Copy to clipboard unavailable.");

  let opened = false;
  let hint: string | undefined;
  if (!options.noOpen) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      opened = await openUrl(dashboardUrl);
    }
    if (!opened) {
      hint = formatControlUiSshHint({
        port,
        basePath,
      });
    }
  } else {
    hint =
      copied && includeTokenInUrl
        ? "Browser launch disabled (--no-open). Token-authenticated URL copied to clipboard."
        : "Browser launch disabled (--no-open). Use the URL above.";
  }

  const fallbackToManualAuth = !copied && !opened && includeTokenInUrl;
  const suppressNoOpenHint = options.noOpen === true && fallbackToManualAuth;

  if (opened) {
    runtime.log("Opened in your browser. Keep that tab to control OpenClaw.");
  } else if (hint && !suppressNoOpenHint) {
    runtime.log(hint);
  }

  if (fallbackToManualAuth) {
    runtime.log(
      "Token auto-auth not delivered. Append your gateway token (from OPENCLAW_GATEWAY_TOKEN or gateway.auth.token) as a URL fragment with key `token` to authenticate.",
    );
  }
}
