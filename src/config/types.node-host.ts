export type NodeHostBrowserProxyConfig = {
  /** Enable the browser proxy on the node host (default: true). */
  enabled?: boolean;
  /** Optional allowlist of profile names exposed via the proxy. */
  allowProfiles?: string[];
};

export type NodeHostConfig = {
  /** Browser proxy settings for node hosts. */
  browserProxy?: NodeHostBrowserProxyConfig;
};
