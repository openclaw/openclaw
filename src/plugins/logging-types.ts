// Public plugin logger metadata contracts.

export type PluginLogOutcome = "failure" | "success" | "warning";

export type PluginLogSemantics = {
  event?: string;
  category?: string;
  outcome?: PluginLogOutcome;
  reason?: string;
};
