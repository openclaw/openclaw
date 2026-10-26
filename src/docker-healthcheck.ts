import { fileURLToPath } from "node:url";
import { createConfigIO } from "./config/config.js";
import { parseGatewayPortEnvValue, resolveGatewayPort } from "./config/paths.js";
import { readActiveGatewayLockPort } from "./infra/gateway-lock.js";
import { isMainModule } from "./infra/is-main.js";

async function resolveDockerHealthcheckPort(): Promise<number> {
  try {
    // The live lock records CLI --port and is authoritative. Config/env only cover startup
    // before the Gateway has acquired its lock or platforms where the owner cannot be verified.
    const activePort = await readActiveGatewayLockPort({ env: process.env });
    if (activePort !== undefined) {
      return activePort;
    }
  } catch {
    // A best-effort lock read must not hide a healthy Gateway on the configured port.
  }

  // The env override must survive a config that fails to load; resolving it only after
  // loading config would let a corrupt/unreadable config defeat the fallback entirely.
  const envPort = parseGatewayPortEnvValue(process.env.OPENCLAW_GATEWAY_PORT);
  if (envPort !== null) {
    return envPort;
  }

  const config = await createConfigIO({
    pluginValidation: "skip",
    shellEnvFallback: "defer",
  }).loadConfigAsync();
  return resolveGatewayPort(config, process.env);
}

export async function probeDockerGatewayHealth(): Promise<boolean> {
  try {
    const port = await resolveDockerHealthcheckPort();
    const response = await globalThis.fetch(`http://127.0.0.1:${port}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

if (
  isMainModule({
    currentFile: fileURLToPath(import.meta.url),
  })
) {
  void probeDockerGatewayHealth().then((healthy) => {
    process.exitCode = healthy ? 0 : 1;
  });
}
