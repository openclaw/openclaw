import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { copyToClipboard } from "../infra/clipboard.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { secretRefKey } from "../secrets/ref-contract.js";
import { resolveSecretRefValues } from "../secrets/resolve.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  resolveControlUiLinks,
} from "./onboard-helpers.js";

type DashboardOptions = {
  noOpen?: boolean;
};

function readGatewayTokenEnv(env: NodeJS.ProcessEnv): string | undefined {
  const primary = env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (primary) {
    return primary;
  }
  const legacy = env.CLAWDBOT_GATEWAY_TOKEN?.trim();
  return legacy || undefined;
}

async function resolveDashboardToken(
  cfg: OpenClawConfig,
): Promise<{ token?: string; unresolvedRefReason?: string }> {
  const configToken =
    typeof cfg.gateway?.auth?.token === "string" ? cfg.gateway.auth.token.trim() : undefined;
  if (configToken) {
    return { token: configToken };
  }
  const { ref } = resolveSecretInputRef({
    value: cfg.gateway?.auth?.token,
    defaults: cfg.secrets?.defaults,
  });
  if (!ref) {
    return { token: readGatewayTokenEnv(process.env) };
  }
  try {
    const resolved = await resolveSecretRefValues([ref], {
      config: cfg,
      env: process.env,
    });
    const value = resolved.get(secretRefKey(ref));
    if (typeof value === "string" && value.trim().length > 0) {
      return { token: value.trim() };
    }
    const envToken = readGatewayTokenEnv(process.env);
    return envToken
      ? { token: envToken }
      : { unresolvedRefReason: "gateway.auth.token SecretRef resolved to an empty value." };
  } catch (err) {
    const envToken = readGatewayTokenEnv(process.env);
    return envToken
      ? { token: envToken }
      : { unresolvedRefReason: `gateway.auth.token SecretRef is unresolved (${String(err)}).` };
  }
}

export async function dashboardCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DashboardOptions = {},
) {
  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.valid ? snapshot.config : {};
  const port = resolveGatewayPort(cfg);
  const bind = cfg.gateway?.bind ?? "loopback";
  const basePath = cfg.gateway?.controlUi?.basePath;
  const customBindHost = cfg.gateway?.customBindHost;
  const resolvedToken = await resolveDashboardToken(cfg);
  const token = resolvedToken.token ?? "";

  // LAN URLs fail secure-context checks in browsers.
  // Coerce only lan->loopback and preserve other bind modes.
  const links = resolveControlUiLinks({
    port,
    bind: bind === "lan" ? "loopback" : bind,
    customBindHost,
    basePath,
  });
  // Prefer URL fragment to avoid leaking auth tokens via query params.
  const dashboardUrl = token
    ? `${links.httpUrl}#token=${encodeURIComponent(token)}`
    : links.httpUrl;

  runtime.log(`Dashboard URL: ${dashboardUrl}`);
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
        token: token || undefined,
      });
    }
  } else {
    hint = "Browser launch disabled (--no-open). Use the URL above.";
  }

  if (opened) {
    runtime.log("Opened in your browser. Keep that tab to control OpenClaw.");
  } else if (hint) {
    runtime.log(hint);
  }
}
