import type { PluginInstallActivity } from "../../../../packages/gateway-protocol/src/schema/plugins.js";

export type PluginInstallProgress = {
  startedAt: number;
  activities: readonly PluginInstallActivity[];
  finishedAt?: number;
  canRetry?: boolean;
};
