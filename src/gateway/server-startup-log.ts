import chalk from "chalk";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import type { loadConfig } from "../config/config.js";
import { getResolvedLoggerSettings } from "../logging.js";
import { isLoopbackHost } from "./net.js";
import { resolveGatewayAuth } from "./auth.js";

export async function logGatewayStartup(params: {
  cfg: ReturnType<typeof loadConfig>;
  bindHost: string;
  bindHosts?: string[];
  port: number;
  tlsEnabled?: boolean;
  log: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string) => void;
  };
  isNixMode: boolean;
}) {
  // Security warning for exposed gateway without proper protection
  const isExposed = !isLoopbackHost(params.bindHost);
  if (isExposed) {
    const tailscaleMode = params.cfg.gateway?.tailscale?.mode ?? "off";
    const auth = resolveGatewayAuth({
      authConfig: params.cfg.gateway?.auth,
      env: process.env,
      tailscaleMode,
    });

    const hasStrongToken = auth.mode === "token" && (auth.token?.length ?? 0) >= 32;
    const hasStrongPassword = auth.mode === "password" && (auth.password?.length ?? 0) >= 16;
    const hasStrongAuth = hasStrongToken || hasStrongPassword;
    const hasTls = params.tlsEnabled === true;

    // Show warning if exposed without both TLS and strong auth
    if (!hasTls || !hasStrongAuth) {
      const warn = params.log.warn ?? params.log.info;
      warn("");
      warn("╔═════════════════════════════════════════════════════════╗");
      warn("║            ⚠️  SECURITY WARNING  ⚠️                     ║");
      warn("║                                                         ║");
      warn("║  Gateway is exposed on network!                        ║");
      warn(`║  Binding: ${params.bindHost.padEnd(42)} ║`);
      if (!hasTls) {
        warn("║  TLS: DISABLED (traffic is unencrypted)                ║");
      }
      if (!hasStrongAuth) {
        warn("║  Auth: WEAK or MISSING                                 ║");
      }
      warn("║                                                         ║");
      warn("║  Anyone on your network can potentially access!        ║");
      warn("║                                                         ║");
      warn("║  Recommended:                                           ║");
      warn("║  - Use bind='loopback' for local-only access, OR       ║");
      if (!hasStrongAuth) {
        warn("║  - Set strong gateway.auth.token (32+ chars)           ║");
      }
      if (!hasTls) {
        warn("║  - Enable gateway.tls.enabled=true                      ║");
      }
      warn("╚═════════════════════════════════════════════════════════╝");
      warn("");

      // Delay 5 seconds to ensure user sees the warning
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  const { provider: agentProvider, model: agentModel } = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const modelRef = `${agentProvider}/${agentModel}`;
  params.log.info(`agent model: ${modelRef}`, {
    consoleMessage: `agent model: ${chalk.whiteBright(modelRef)}`,
  });
  const scheme = params.tlsEnabled ? "wss" : "ws";
  const formatHost = (host: string) => (host.includes(":") ? `[${host}]` : host);
  const hosts =
    params.bindHosts && params.bindHosts.length > 0 ? params.bindHosts : [params.bindHost];
  const primaryHost = hosts[0] ?? params.bindHost;
  params.log.info(
    `listening on ${scheme}://${formatHost(primaryHost)}:${params.port} (PID ${process.pid})`,
  );
  for (const host of hosts.slice(1)) {
    params.log.info(`listening on ${scheme}://${formatHost(host)}:${params.port}`);
  }
  params.log.info(`log file: ${getResolvedLoggerSettings().file}`);
  if (params.isNixMode) {
    params.log.info("gateway: running in Nix mode (config managed externally)");
  }
}
