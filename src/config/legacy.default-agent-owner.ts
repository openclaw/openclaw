import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { tryResolveLegacyDataOwnerAgentId } from "../agents/agent-scope-config.js";
import {
  getRetainedLegacyDefaultAgentId,
  setRetainedLegacyDefaultAgentId,
} from "./legacy.default-agent-owner-state.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function retainLegacyDefaultAgentId<T extends object>(
  config: T,
  agentId: string | undefined,
): T {
  setRetainedLegacyDefaultAgentId(config, agentId ? normalizeAgentId(agentId) : undefined);
  return config;
}

export function inheritLegacyDefaultAgentId<T extends object>(source: unknown, target: T): T {
  return retainLegacyDefaultAgentId(target, tryGetLegacyDefaultAgentId(source));
}

export function tryGetLegacyDefaultAgentId(config: unknown): string | undefined {
  return (typeof config === "object" && config !== null) || typeof config === "function"
    ? getRetainedLegacyDefaultAgentId(config)
    : undefined;
}
export { tryResolveLegacyCompatibilityAgentId } from "../agents/agent-scope-config.js";

export function resolveSessionStoreCompatibilityAgentId(config: OpenClawConfig): string {
  const persistedAgentId = config.agents?.defaults?.sessionStore?.agentId?.trim();
  return persistedAgentId
    ? normalizeAgentId(persistedAgentId)
    : (tryResolveLegacyDataOwnerAgentId(config) ?? "main");
}
