// Implements `openclaw dashboard` URL resolution, readiness check, clipboard, and browser launch.
import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { resolveGatewayAuthToken } from "../gateway/auth-token-resolution.js";
import { copyToClipboard } from "../infra/clipboard.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { ensureGatewayReadyForOperation } from "./gateway-readiness.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  resolveControlUiLinks,
} from "./onboard-helpers.js";

type DashboardOptions = {
  copyToken?: boolean;
  noOpen?: boolean;
  yes?: boolean;
};

async function resolveDashboardTarget() {
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
  const links = resolveControlUiLinks({
    port,
    bind: bind === "lan" ? "loopback" : bind,
    customBindHost,
    basePath,
    tlsEnabled: cfg.gateway?.tls?.enabled === true,
  });
  // Avoid embedding externally managed SecretRef tokens in terminal/clipboard/browser args.
  const includeTokenInUrl = token.length > 0 && !resolvedToken.secretRefConfigured;
  // Prefer URL fragment to avoid leaking auth tokens via query params.
  const dashboardUrl = includeTokenInUrl
    ? `${links.httpUrl}#token=${encodeURIComponent(token)}`
    : links.httpUrl;

  return {
    port,
    basePath,
    links,
    resolvedToken,
    token,
    includeTokenInUrl,
    dashboardUrl,
  };
}

/** Open or print the Control UI dashboard URL after ensuring the Gateway is reachable. */
export async function dashboardCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DashboardOptions = {},
) {
  const initialTarget = await resolveDashboardTarget();
  const readiness = await ensureGatewayReadyForOperation({
    runtime,
    operation: "open the dashboard",
    yes: options.yes,
    probeUrl: initialTarget.links.wsUrl,
    readyWhenReachable: true,
  });
  if (!readiness.ready) {
    return;
  }

  const target = readiness.recovered ? await resolveDashboardTarget() : initialTarget;
  const { port, basePath, links, resolvedToken, token, includeTokenInUrl, dashboardUrl } = target;

  runtime.log(`Dashboard URL: ${links.httpUrl}`);
  if (includeTokenInUrl && !options.copyToken) {
    runtime.log("Token auto-auth included in browser/clipboard URL.");
  }
  if (token && options.copyToken) {
    runtime.log("Token auto-auth URL disabled because --copy-token copies the token separately.");
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

  let copied = false;
  if (options.copyToken) {
    if (token) {
      copied = await copyToClipboard(token).catch(() => false);
      runtime.log(
        copied
          ? "Gateway token copied to clipboard. Paste it into the Control UI auth prompt."
          : "Gateway token copy unavailable. Resolve gateway.auth.token or set OPENCLAW_GATEWAY_TOKEN, then paste it into the Control UI auth prompt.",
      );
    } else {
      runtime.log(
        "Gateway token unavailable. Resolve gateway.auth.token or set OPENCLAW_GATEWAY_TOKEN, then rerun `openclaw dashboard --copy-token`.",
      );
    }
  } else {
    copied = await copyToClipboard(dashboardUrl).catch(() => false);
    runtime.log(copied ? "Copied to clipboard." : "Copy to clipboard unavailable.");
  }

  let opened = false;
  let hint: string | undefined;
  const browserUrl = options.copyToken ? links.httpUrl : dashboardUrl;
  if (!options.noOpen) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      opened = await openUrl(browserUrl);
    }
    if (!opened) {
      hint = formatControlUiSshHint({
        port,
        basePath,
      });
    }
  } else if (options.copyToken) {
    hint = copied
      ? "Browser launch disabled (--no-open). Gateway token copied to clipboard."
      : "Browser launch disabled (--no-open). Use the URL above.";
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
