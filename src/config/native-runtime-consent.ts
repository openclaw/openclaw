import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import type { OpenClawConfig } from "./types.openclaw.js";

function resolveConsentAgentKey(config: OpenClawConfig | undefined, agentId: string): string {
  const entries = config?.agents?.entries;
  if (!entries || Object.hasOwn(entries, agentId)) {
    return agentId;
  }
  const normalized = normalizeAgentId(agentId);
  return Object.keys(entries).find((key) => normalizeAgentId(key) === normalized) ?? agentId;
}

export function hasRememberedNativeRuntimeConsent(
  config: OpenClawConfig | undefined,
  agentId: string,
  harnessId: string,
): boolean {
  const key = resolveConsentAgentKey(config, agentId);
  return config?.agents?.entries?.[key]?.nativeRuntimeConsent?.includes(harnessId) === true;
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
  const key = resolveConsentAgentKey(config, agentId);
  const entry = config.agents?.entries?.[key];
  return {
    ...config,
    agents: {
      ...config.agents,
      entries: {
        ...config.agents?.entries,
        [key]: {
          ...entry,
          nativeRuntimeConsent: [...(entry?.nativeRuntimeConsent ?? []), harnessId],
        },
      },
    },
  };
}
