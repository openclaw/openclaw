export type PluginCompatibilityNotice = {
  pluginId: string;
  code: "legacy-before-agent-start" | "hook-only";
  severity: "warn" | "info";
  message: string;
};

export type PluginCompatibilitySummary = {
  noticeCount: number;
  pluginCount: number;
};
