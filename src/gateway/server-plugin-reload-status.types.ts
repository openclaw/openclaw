/** Pending or failed plugin replacement, as recorded by the Gateway plugin runtime generation. */
export type GatewayPluginReloadStatus = Readonly<{
  phase: "reloading" | "recovering" | "failed";
  pluginIds: string[];
  startedAtMs?: number;
  deadlineAtMs?: number;
  reason?: string;
}>;
