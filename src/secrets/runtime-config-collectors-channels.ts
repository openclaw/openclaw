import { listBootstrapChannelPlugins } from "../channels/plugins/bootstrap-registry.js";
import type { MullusiConfig } from "../config/config.js";
import { type ResolverContext, type SecretDefaults } from "./runtime-shared.js";

export function collectChannelConfigAssignments(params: {
  config: MullusiConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  for (const plugin of listBootstrapChannelPlugins()) {
    plugin.secrets?.collectRuntimeConfigAssignments?.(params);
  }
}
