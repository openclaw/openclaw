import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { collectChannelConfigAssignments } from "./runtime-config-collectors-channels.js";
import { collectCoreConfigAssignments } from "./runtime-config-collectors-core.js";
import { collectPluginConfigAssignments } from "./runtime-config-collectors-plugins.js";
import type { ResolverContext } from "./runtime-shared.js";

/** Collects every config-backed SecretRef assignment before runtime values are materialized. */
export async function collectConfigAssignments(params: {
  /** Mutable config snapshot that resolved secret values will be written back into. */
  config: OpenClawConfig;
  context: ResolverContext;
  /** Explicit diagnostic owner for agent-scoped core assignments. */
  agentId?: string;
  /** Optional installed plugin roots for channel/plugin contract lookup. */
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): Promise<void> {
  const { sourceConfig, env } = params.context;
  const managedSyntheticAuthProviders = new Set<string>();
  for (const [provider, entry] of Object.entries(sourceConfig.models?.providers ?? {})) {
    if (!entry.localService) {
      continue;
    }
    const { resolveManagedLocalProviderAuth } = await import("../agents/model-auth-runtime.js");
    if (resolveManagedLocalProviderAuth({ cfg: sourceConfig, provider, env })) {
      managedSyntheticAuthProviders.add(normalizeProviderId(provider));
    }
  }
  params.context.managedSyntheticAuthProviders = managedSyntheticAuthProviders;
  const defaults = params.context.sourceConfig.secrets?.defaults;

  collectCoreConfigAssignments({
    config: params.config,
    defaults,
    context: params.context,
    agentId: params.agentId,
  });

  collectChannelConfigAssignments({
    config: params.config,
    defaults,
    context: params.context,
    loadablePluginOrigins: params.loadablePluginOrigins,
  });

  collectPluginConfigAssignments({
    config: params.config,
    defaults,
    context: params.context,
    loadablePluginOrigins: params.loadablePluginOrigins,
  });
}
