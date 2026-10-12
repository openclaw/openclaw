import { fileURLToPath } from "node:url";
import { getRuntimeConfig } from "./config/config.js";
import { resolveGatewayPort } from "./config/paths.js";
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

  const config = getRuntimeConfig({
    pin: false,
    skipPluginValidation: true,
    skipShellEnvFallback: true,
  });
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
