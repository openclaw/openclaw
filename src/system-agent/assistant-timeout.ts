// Resolves the system-agent turn budget from manifest-owned provider metadata.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  SYSTEM_AGENT_ASSISTANT_LOCAL_TIMEOUT_MS,
  SYSTEM_AGENT_ASSISTANT_TIMEOUT_MS,
} from "./assistant-prompts.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";

export function resolveSystemAgentAssistantTimeoutMs(route: SystemAgentConfiguredRoute): number {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(route.runConfig, route.agentId);
    const snapshot = resolvePluginMetadataSnapshot({
      config: route.runConfig,
      workspaceDir,
      env: process.env,
      allowWorkspaceScopedCurrent: true,
    });
    const plugins = snapshot.plugins;
    const providers = new Set([
      normalizeProviderId(route.provider),
      normalizeProviderId(route.modelLabel.split("/", 1)[0] ?? ""),
    ]);
    const isLocal = plugins.some((plugin) =>
      Object.entries(plugin.modelPricing?.providers ?? {}).some(
        ([provider, pricing]) =>
          providers.has(normalizeProviderId(provider)) && pricing.external === false,
      ),
    );
    return isLocal ? SYSTEM_AGENT_ASSISTANT_LOCAL_TIMEOUT_MS : SYSTEM_AGENT_ASSISTANT_TIMEOUT_MS;
  } catch {
    return SYSTEM_AGENT_ASSISTANT_TIMEOUT_MS;
  }
}
