import { iterateBootstrapChannelPlugins } from "../channels/plugins/bootstrap-registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { type ResolverContext, type SecretDefaults } from "./runtime-shared.js";

export function collectChannelConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  if (!params.config.channels || Object.keys(params.config.channels).length === 0) {
    return;
  }
  for (const plugin of iterateBootstrapChannelPlugins()) {
    plugin.secrets?.collectRuntimeConfigAssignments?.(params);
  }
}
