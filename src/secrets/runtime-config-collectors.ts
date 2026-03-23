import type { OpenClawConfig } from "../config/config.js";
import { collectChannelConfigAssignments } from "./runtime-config-collectors-channels.js";
import { collectCoreConfigAssignments } from "./runtime-config-collectors-core.js";
import type { ResolverContext } from "./runtime-shared.js";

export function collectConfigAssignments(params: {
  config: OpenClawConfig;
  context: ResolverContext;
}): void {
  const defaults = params.context.sourceConfig.secrets?.defaults;

  collectCoreConfigAssignments({
    config: params.config,
    defaults,
    context: params.context,
  });

  collectChannelConfigAssignments({
    config: params.config,
    defaults,
    context: params.context,
  });
}
