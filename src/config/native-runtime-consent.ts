import type { OpenClawConfig } from "./types.openclaw.js";

export function hasRememberedNativeRuntimeConsent(
  config: OpenClawConfig | undefined,
  agentId: string,
  harnessId: string,
): boolean {
  return config?.agents?.entries?.[agentId]?.nativeRuntimeConsent?.includes(harnessId) === true;
}

/** Stages explicit operator consent in the same config commit as agent setup. */
export function rememberNativeRuntimeConsent(
  config: OpenClawConfig,
  agentId: string,
  harnessId: string,
): OpenClawConfig {
  if (hasRememberedNativeRuntimeConsent(config, agentId, harnessId)) {
    return config;
  }
  const entry = config.agents?.entries?.[agentId];
  return {
    ...config,
    agents: {
      ...config.agents,
      entries: {
        ...config.agents?.entries,
        [agentId]: {
          ...entry,
          nativeRuntimeConsent: [...(entry?.nativeRuntimeConsent ?? []), harnessId],
        },
      },
    },
  };
}
