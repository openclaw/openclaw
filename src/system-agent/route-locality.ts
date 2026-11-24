import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";

/**
 * Whether a route's provider runs on this machine, per plugin pricing metadata
 * (`external: false`). Local servers may load a model before answering, so their
 * system-agent turns get a longer budget than remote APIs. Unknown means remote.
 */
export function isLocalSystemAgentRoute(route: {
  runConfig: OpenClawConfig;
  agentId: string;
  provider: string;
  modelLabel: string;
}): boolean {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(route.runConfig, route.agentId);
    const snapshot = resolvePluginMetadataSnapshot({
      config: route.runConfig,
      workspaceDir,
      env: process.env,
      allowWorkspaceScopedCurrent: true,
    });
    const providers = new Set([
      normalizeProviderId(route.provider),
      normalizeProviderId(route.modelLabel.split("/", 1)[0] ?? ""),
    ]);
    return snapshot.plugins.some((plugin) =>
      Object.entries(plugin.modelPricing?.providers ?? {}).some(
        ([provider, pricing]) =>
          providers.has(normalizeProviderId(provider)) && pricing.external === false,
      ),
    );
  } catch {
    return false;
  }
}
