import type { OpenClawConfig } from "./types.openclaw.js";

/** Retains generated owner display secrets in memory without persisting them into config. */
export function retainGeneratedOwnerDisplaySecret(params: {
  config: OpenClawConfig;
  configPath: string;
  generatedSecret?: string;
  state: { pendingByPath: Map<string, string> };
}): OpenClawConfig {
  const { config, configPath, generatedSecret, state } = params;
  if (generatedSecret) {
    state.pendingByPath.set(configPath, generatedSecret);
  } else {
    state.pendingByPath.delete(configPath);
  }
  return config;
}
