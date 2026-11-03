import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function fixedStoreOwnershipConfig(storePath: string, owned = true): OpenClawConfig {
  return {
    session: { scope: "global", store: storePath },
    agents: {
      ownership: "explicit",
      ...(owned ? { defaults: { sessionStore: { agentId: "ops" } } } : {}),
      entries: { ops: {}, research: {} },
    },
  };
}
