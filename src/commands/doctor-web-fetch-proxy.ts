/** Doctor diagnostics for managed loopback and web_fetch proxy routing. */
import tls from "node:tls";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayService, type GatewayService } from "../daemon/service.js";
import { hasEnvHttpProxyConfigured } from "../infra/net/proxy-env.js";
import { probeManagedProxyLoopback } from "../infra/net/proxy/proxy-validation.js";
import { shouldManageGatewayService } from "./doctor-service-repair-policy.js";

const DIRECT_PROBE_HOST = "docs.openclaw.ai";
const DIRECT_PROBE_PORT = 443;
const DIRECT_PROBE_TIMEOUT_MS = 3_000;
const HTTP_PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const;

type DirectConnectivity = "reachable" | "unreachable";

type ProxyEnvSource = {
  env: NodeJS.ProcessEnv;
  label: "doctor process" | "installed Gateway service";
};

function listConfiguredProxyKeys(env: NodeJS.ProcessEnv): string[] {
  return HTTP_PROXY_ENV_KEYS.filter((key) => Boolean(env[key]?.trim()));
}

async function probeDirectTlsConnectivity(): Promise<DirectConnectivity> {
  return await new Promise((resolve) => {
    let settled = false;
    const socket = tls.connect({
      host: DIRECT_PROBE_HOST,
      port: DIRECT_PROBE_PORT,
      servername: DIRECT_PROBE_HOST,
      timeout: DIRECT_PROBE_TIMEOUT_MS,
    });
    const finish = (result: DirectConnectivity) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once("secureConnect", () => finish("reachable"));
    socket.once("timeout", () => finish("unreachable"));
    socket.once("error", () => finish("unreachable"));
  });
}

async function resolveProxyEnvSources(params: {
  env: NodeJS.ProcessEnv;
  service: Pick<GatewayService, "readCommand">;
}): Promise<ProxyEnvSource[]> {
  const sources: ProxyEnvSource[] = [];
  if (hasEnvHttpProxyConfigured("https", params.env)) {
    sources.push({ env: params.env, label: "doctor process" });
  }
  if (!(await shouldManageGatewayService(params.env))) {
    return sources;
  }
  const command = await params.service.readCommand(params.env).catch(() => null);
  const serviceEnv = command?.environment;
  if (serviceEnv && hasEnvHttpProxyConfigured("https", serviceEnv)) {
    sources.push({ env: serviceEnv, label: "installed Gateway service" });
  }
  return sources;
}

/** Builds a read-only diagnostic when proxy env exists but web_fetch remains direct. */
async function collectWebFetchProxyDiagnostic(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  service?: Pick<GatewayService, "readCommand">;
  probeDirectConnectivity?: () => Promise<DirectConnectivity>;
}): Promise<string | null> {
  if (
    params.cfg.gateway?.mode === "remote" ||
    params.cfg.tools?.web?.fetch?.enabled === false ||
    params.cfg.tools?.web?.fetch?.useTrustedEnvProxy === true
  ) {
    return null;
  }

  const env = params.env ?? process.env;
  const sources = await resolveProxyEnvSources({
    env,
    service: params.service ?? resolveGatewayService(),
  });
  if (sources.length === 0) {
    return null;
  }

  const directConnectivity = await (params.probeDirectConnectivity ?? probeDirectTlsConnectivity)();
  const sourceLines = sources.map((source) => {
    const keys = listConfiguredProxyKeys(source.env);
    return `- HTTP(S) proxy environment detected in the ${source.label}: ${keys.join(", ")}.`;
  });
  const directProbe =
    directConnectivity === "reachable"
      ? `- Direct TLS connectivity to ${DIRECT_PROBE_HOST}:${DIRECT_PROBE_PORT} succeeded.`
      : `- Direct TLS connectivity to ${DIRECT_PROBE_HOST}:${DIRECT_PROBE_PORT} failed.`;

  return [
    ...sourceLines,
    "- web_fetch still uses direct connections because tools.web.fetch.useTrustedEnvProxy is not enabled.",
    directProbe,
    "- If direct web_fetch requests time out and the proxy is operator-controlled, enable the explicit opt-in:",
    `  ${formatCliCommand("openclaw config set tools.web.fetch.useTrustedEnvProxy true")}`,
    "- Keep the opt-in disabled for untrusted proxies; enabling it lets the proxy resolve DNS after OpenClaw's hostname checks.",
  ].join("\n");
}

/** Emits a managed-loopback failure or the web_fetch proxy diagnostic when relevant. */
export async function noteWebFetchProxyDiagnostic(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  service?: Pick<GatewayService, "readCommand">;
  probeDirectConnectivity?: () => Promise<DirectConnectivity>;
  noteFn?: typeof note;
}): Promise<void> {
  if (params.cfg.gateway?.mode === "remote") {
    return;
  }
  const env = params.env ?? process.env;
  const loopbackReachable = await probeManagedProxyLoopback({
    config: params.cfg.proxy,
    env,
  }).catch(() => false);
  if (loopbackReachable === false) {
    const loopbackMode = params.cfg.proxy?.loopbackMode ?? env.OPENCLAW_PROXY_LOOPBACK_MODE;
    const repair =
      loopbackMode === "proxy" || loopbackMode === "block"
        ? [
            `- proxy.loopbackMode=${loopbackMode} prevents direct local routing. Restore it with:`,
            `  ${formatCliCommand("openclaw config set proxy.loopbackMode gateway-only")}`,
          ]
        : [
            "- Temporarily disable managed routing to recover local connections:",
            `  ${formatCliCommand("openclaw config set proxy.enabled false")}`,
            "- If external traffic requires a proxy, keep HTTP_PROXY/HTTPS_PROXY and set NO_PROXY=127.0.0.1,localhost,::1 in the Gateway service environment.",
          ];
    (params.noteFn ?? note)(
      [
        "- Managed proxy routing (proxy.enabled) is active, but a request to this process's loopback listener failed. This can cause WebChat/Codex handshake errors or 502 responses.",
        `- Inspect the proxy configuration: ${formatCliCommand("openclaw config get proxy")}`,
        ...repair,
        `- Apply the change: ${formatCliCommand("openclaw gateway restart")}`,
      ].join("\n"),
      "Managed proxy loopback",
    );
    return;
  }
  const diagnostic = await collectWebFetchProxyDiagnostic(params);
  if (diagnostic) {
    (params.noteFn ?? note)(diagnostic, "Web fetch proxy");
  }
}
