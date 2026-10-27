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

/**
 * Remembered agent consent covers an owner's chat that has not chosen a narrower mode itself:
 * its unset modes count as Full access with sandbox off. A sandbox from agent config still applies,
 * and an explicit chat mode is never replaced.
 */
export function withOwnerNativeConsentModes<
  T extends { permissionMode?: string; sandboxMode?: string },
>(entry: T, ownerTurn: boolean | undefined, sandboxed: boolean): T {
  return ownerTurn === true && !sandboxed
    ? {
        ...entry,
        permissionMode: entry.permissionMode ?? "full",
        sandboxMode: entry.sandboxMode ?? "off",
      }
    : entry;
}
