const CHANNEL_KERNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
const CHANNEL_NAMESPACE_PREFIX = "channels.";

/** Return whether a channel config key names a kernel-owned namespace. */
export function isKernelOwnedChannelConfigKey(key: string): boolean {
  return CHANNEL_KERNEL_CONFIG_KEYS.has(key);
}

/** Channel schema hints outside the kernel namespaces belong to their plugins. */
export function isPluginOwnedChannelConfigPath(path: string): boolean {
  if (!path.startsWith(CHANNEL_NAMESPACE_PREFIX)) {
    return false;
  }
  const channelKey = path.slice(CHANNEL_NAMESPACE_PREFIX.length).split(".", 1)[0];
  return channelKey === undefined || !isKernelOwnedChannelConfigKey(channelKey);
}
