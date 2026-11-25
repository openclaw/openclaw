export type PluginBindingApprovalEntry = {
  pluginRoot: string;
  pluginId: string;
  pluginName?: string;
  channel: string;
  accountId: string;
  approvedAt: number;
};
