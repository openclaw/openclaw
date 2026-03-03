import { resolveCommandSecretRefsViaGateway } from "../../cli/command-secret-gateway.js";
import { getModelsCommandSecretTargetIds } from "../../cli/command-secret-targets.js";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";

export async function loadModelsConfig(params: {
  commandName: string;
  runtime?: RuntimeEnv;
}): Promise<OpenClawConfig> {
  const loadedRaw = loadConfig();
  const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway({
    config: loadedRaw,
    commandName: params.commandName,
    targetIds: getModelsCommandSecretTargetIds(),
  });
  if (params.runtime) {
    for (const entry of diagnostics) {
      params.runtime.log(`[secrets] ${entry}`);
    }
  }
  return resolvedConfig;
}
