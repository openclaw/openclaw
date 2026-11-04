import type { OpenClawConfig } from "../config/types.openclaw.js";

export function createVisitorAccessPluginConfig(
  accountId: string,
  appId: string,
  apiToken: string,
): NonNullable<OpenClawConfig["plugins"]> {
  return {
    allow: ["visitor-access"],
    slots: { memory: "none" },
    entries: { "visitor-access": { enabled: true, config: { accountId, appId, apiToken } } },
  };
}
