// Keep listener and deployment port admission together before Gateway startup.
import { resolveGatewayPort } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseTcpPort } from "../../infra/tcp-port.js";
import { formatInvalidConfigPort, formatInvalidPortOption } from "../error-format.js";
import type { GatewayRunOpts } from "./run-options.js";

export function resolveGatewayRunPorts(
  opts: Pick<GatewayRunOpts, "port" | "publishedPort">,
  cfg: OpenClawConfig,
): { port: number; publishedPort: number | null } | { error: string; exitCode: 1 | 78 } {
  const portOverride = parseTcpPort(opts.port);
  if (opts.port !== undefined && portOverride === null) {
    return { error: formatInvalidPortOption("--port"), exitCode: 1 };
  }
  const publishedPort = parseTcpPort(opts.publishedPort);
  if (opts.publishedPort !== undefined && publishedPort === null) {
    return { error: formatInvalidPortOption("--published-port"), exitCode: 1 };
  }
  const port = portOverride ?? resolveGatewayPort(cfg);
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) {
    return { error: formatInvalidConfigPort("gateway.port"), exitCode: 78 };
  }
  return { port, publishedPort };
}
