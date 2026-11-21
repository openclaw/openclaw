import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readEmbeddedGatewayToken } from "../../daemon/service-audit.js";
import type { GatewayServiceCommandSnapshot } from "../../daemon/service-types.js";
import { resolveGatewayAuthToken } from "../../gateway/auth-token-resolution.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import { formatCliCommand } from "../command-format.js";

/** Explicit options the already-installed fast path would otherwise report as applied. */
export async function resolveUnappliedInstalledOptions(params: {
  command: GatewayServiceCommandSnapshot | null;
  port: number;
  portExplicit: boolean;
  token?: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<{ unapplied: string[]; hints: string[] }> {
  const unapplied: string[] = [];
  const hints: string[] = [];
  if (!params.command) {
    return { unapplied, hints };
  }
  if (params.portExplicit) {
    const installedPort = parseTcpPortFromArgs(params.command.programArguments);
    if (installedPort !== params.port) {
      unapplied.push(`--port ${params.port}`);
      hints.push(
        `Reinstall with: ${formatCliCommand(`openclaw gateway install --force --port ${params.port}`)}.`,
      );
    }
  }
  if (params.token !== undefined) {
    let installedToken = readEmbeddedGatewayToken(params.command);
    if (installedToken === undefined) {
      // Healthy services can resolve credentials from config or env files instead of supervisor metadata.
      const configured = await resolveGatewayAuthToken({
        cfg: params.cfg,
        env: params.env,
        envFallback: "no-secret-ref",
      });
      if (!configured.secretRefConfigured) {
        installedToken = configured.token;
      }
    }
    if (installedToken !== undefined && installedToken !== params.token) {
      unapplied.push("--token");
      hints.push(
        `Set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN, then run ${formatCliCommand("openclaw gateway install --force")}; install does not persist --token.`,
      );
    }
  }
  return { unapplied, hints };
}
