import { getBundledChannelContractSurfaces } from "../channels/plugins/contract-surfaces.js";
import type { OpenClawConfig } from "../config/config.js";
import { type ResolverContext, type SecretDefaults } from "./runtime-shared.js";

type ChannelRuntimeConfigCollectorSurface = {
  collectRuntimeConfigAssignments?: (params: {
    config: OpenClawConfig;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
  }) => void;
};

function listChannelRuntimeConfigCollectorSurfaces(): ChannelRuntimeConfigCollectorSurface[] {
  return getBundledChannelContractSurfaces() as ChannelRuntimeConfigCollectorSurface[];
}

export function collectChannelConfigAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  for (const surface of listChannelRuntimeConfigCollectorSurfaces()) {
    surface.collectRuntimeConfigAssignments?.(params);
  }
}
