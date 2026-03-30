import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { copyToClipboard } from "../infra/clipboard.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveControlUiAccessUrl } from "./control-ui-access-url.js";
import { detectBrowserOpenSupport, formatControlUiSshHint, openUrl } from "./onboard-helpers.js";

type DashboardOptions = {
  noOpen?: boolean;
};

export async function dashboardCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DashboardOptions = {},
) {
  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : {};
  const port = resolveGatewayPort(cfg);
  const basePath = cfg.gateway?.controlUi?.basePath;
  const access = await resolveControlUiAccessUrl({ cfg, env: process.env });
  const dashboardUrl = access.dashboardUrl;
  const includeTokenInUrl = access.tokenFragmentEmbedded;
  const token = access.authToken ?? "";

  runtime.log(`Dashboard URL: ${dashboardUrl}`);
  if (access.tokenSecretRefConfigured && token) {
    runtime.log(
      "Token auto-auth is disabled for SecretRef-managed gateway.auth.token; use your external token source if prompted.",
    );
  }
  if (access.unresolvedRefReason) {
    runtime.log(`Token auto-auth unavailable: ${access.unresolvedRefReason}`);
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
        token: includeTokenInUrl ? token : undefined,
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
