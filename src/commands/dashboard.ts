import { formatCliCommand } from "../cli/command-format.js";
import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";
import { readGatewayTokenEnv } from "../gateway/credentials.js";
import { probeGateway } from "../gateway/probe.js";
import { resolveConfiguredSecretInputWithFallback } from "../gateway/resolve-configured-secret-input-string.js";
import { copyToClipboard } from "../infra/clipboard.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  resolveControlUiLinks,
} from "./onboard-helpers.js";
import { getDaemonStatusSummary } from "./status.daemon.js";
import { resolveGatewayProbeAuthResolution } from "./status.gateway-probe.js";

type DashboardOptions = {
  noOpen?: boolean;
};

function looksLikeGatewayReachableClose(
  code: number | undefined,
  reason: string | undefined,
): boolean {
  if (code !== 1008) {
    return false;
  }
  const normalized = (reason ?? "").toLowerCase();
  return (
    normalized.includes("auth") ||
    normalized.includes("token") ||
    normalized.includes("password") ||
    normalized.includes("scope") ||
    normalized.includes("role") ||
    normalized.includes("device identity")
  );
}

async function shouldBlockOnUnreachableGateway(params: {
  cfg: OpenClawConfig;
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  probeWsUrl: string;
  runtime: RuntimeEnv;
}): Promise<boolean> {
  if (params.cfg.gateway?.mode === "remote") {
    return false;
  }

  const authResolution = await resolveGatewayProbeAuthResolution(params.cfg);
  const probe = await probeGateway({
    url: params.probeWsUrl,
    auth: authResolution.auth,
    timeoutMs: 1_500,
    includeDetails: false,
  }).catch(() => null);

  if (!probe) {
    return false;
  }
  if (probe.ok || looksLikeGatewayReachableClose(probe.close?.code, probe.close?.reason)) {
    return false;
  }

  const detail = probe.error ? ` (${probe.error})` : "";
  params.runtime.error(`Gateway is not reachable at ${params.probeWsUrl}${detail}.`);

  if (!params.snapshot.exists) {
    params.runtime.log(`Missing config: run ${formatCliCommand("openclaw setup")}.`);
  } else if (!params.cfg.gateway?.mode) {
    params.runtime.log(
      `Gateway mode is unset; local gateway start is blocked. Run ${formatCliCommand("openclaw config set gateway.mode local")}.`,
    );
  }

  const daemon = await getDaemonStatusSummary().catch(() => null);
  if (daemon?.installed === false) {
    params.runtime.log(
      `Gateway service is not installed. Run ${formatCliCommand("openclaw daemon install")}.`,
    );
  } else if (daemon?.installed && !daemon.loaded) {
    params.runtime.log(
      `Gateway service is installed but not loaded. Run ${formatCliCommand("openclaw daemon start")}.`,
    );
  } else if (daemon?.installed) {
    params.runtime.log(
      `Gateway service appears installed. Try ${formatCliCommand("openclaw daemon restart")} if the dashboard still stays down.`,
    );
  }

  params.runtime.log(`Fix reachability first: ${formatCliCommand("openclaw gateway probe")}`);
  return true;
}

async function resolveDashboardToken(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  token?: string;
  source?: "config" | "env" | "secretRef";
  unresolvedRefReason?: string;
  tokenSecretRefConfigured: boolean;
}> {
  const resolved = await resolveConfiguredSecretInputWithFallback({
    config: cfg,
    env,
    value: cfg.gateway?.auth?.token,
    path: "gateway.auth.token",
    readFallback: () => readGatewayTokenEnv(env),
  });
  return {
    token: resolved.value,
    source:
      resolved.source === "config"
        ? "config"
        : resolved.source === "secretRef"
          ? "secretRef"
          : resolved.source === "fallback"
            ? "env"
            : undefined,
    unresolvedRefReason: resolved.unresolvedRefReason,
    tokenSecretRefConfigured: resolved.secretRefConfigured,
  };
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
  const resolvedToken = await resolveDashboardToken(cfg, process.env);
  const token = resolvedToken.token ?? "";

  // LAN URLs fail secure-context checks in browsers.
  // Coerce only lan->loopback and preserve other bind modes.
  const links = resolveControlUiLinks({
    port,
    bind: bind === "lan" ? "loopback" : bind,
    customBindHost,
    basePath,
  });
  // Avoid embedding externally managed SecretRef tokens in terminal/clipboard/browser args.
  const includeTokenInUrl = token.length > 0 && !resolvedToken.tokenSecretRefConfigured;
  // Prefer URL fragment to avoid leaking auth tokens via query params.
  const dashboardUrl = includeTokenInUrl
    ? `${links.httpUrl}#token=${encodeURIComponent(token)}`
    : links.httpUrl;

  runtime.log(`Dashboard URL: ${dashboardUrl}`);
  if (resolvedToken.tokenSecretRefConfigured && token) {
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

  if (!options.noOpen) {
    const localProbeWsUrl = resolveControlUiLinks({
      port,
      bind: "loopback",
      basePath,
    }).wsUrl;
    if (
      await shouldBlockOnUnreachableGateway({
        cfg,
        snapshot,
        probeWsUrl: localProbeWsUrl,
        runtime,
      })
    ) {
      return;
    }
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
        token: includeTokenInUrl ? token || undefined : undefined,
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
