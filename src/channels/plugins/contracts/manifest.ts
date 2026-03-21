export const channelPluginSurfaceKeys = [
  "actions",
  "setup",
  "status",
  "outbound",
  "messaging",
  "threading",
  "directory",
  "gateway",
] as const;

export type ChannelPluginSurface = (typeof channelPluginSurfaceKeys)[number];

export const sessionBindingContractChannelIds = [
  "discord",
  "feishu",
  "matrix",
  "telegram",
] as const;

export type SessionBindingContractChannelId = (typeof sessionBindingContractChannelIds)[number];
