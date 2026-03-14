export type BrowserProfileConfig = {
  /** CDP port for this profile. Allocated once at creation, persisted permanently. */
  cdpPort?: number;
  /** CDP URL for this profile (use for remote Chrome). */
  cdpUrl?: string;
  /** Profile driver (default: openclaw). */
  driver?: "openclaw" | "clawd" | "extension";
  /** If true, never launch a browser for this profile; only attach. Falls back to browser.attachOnly. */
  attachOnly?: boolean;
  /** Profile color (hex). Auto-assigned at creation. */
  color: string;
};
export type BrowserSnapshotDefaults = {
  /** Default snapshot mode (applies when mode is not provided). */
  mode?: "efficient";
};
export type BrowserSsrFPolicyConfig = {
  /** Legacy alias for private-network access. Prefer dangerouslyAllowPrivateNetwork. */
  allowPrivateNetwork?: boolean;
  /** If true, permit browser navigation to private/internal networks. Default: true */
  dangerouslyAllowPrivateNetwork?: boolean;
  /**
   * Explicitly allowed hostnames (exact-match), including blocked names like localhost.
   * Example: ["localhost", "metadata.internal"]
   */
  allowedHostnames?: string[];
  /**
   * Hostname allowlist patterns for browser navigation.
   * Supports exact hosts and "*.example.com" wildcard subdomains.
   */
  hostnameAllowlist?: string[];
};
export type BrowserMcpConfig = {
  /**
   * Enable the Chrome DevTools MCP preset for agent sessions. Default: false.
   * Requires browser.enabled=true.
   * Chrome DevTools MCP access is disabled when browser.evaluateEnabled=false, including
   * explicit ACPX mcpServers["chrome-devtools"] overrides.
   * Chrome DevTools MCP access is also disabled when browser.ssrfPolicy blocks private-network
   * navigation or configures a hostname allowlist, because DevTools MCP cannot enforce those guards.
   */
  enabled?: boolean;
  /**
   * Tool exposure mode.
   * - "full": all 29 DevTools MCP tools (input, navigation, debugging, performance, network, emulation).
   * - "slim": 3 essential tools only (navigate, evaluate_script, take_screenshot).
   *   Chrome DevTools MCP access respects browser.evaluateEnabled because slim mode includes evaluate_script.
   * Default: "full"
   */
  mode?: "full" | "slim";
  /**
   * Chrome channel to connect to.
   * Default: "stable". Use "beta", "canary", or "dev" for pre-release Chrome builds.
   */
  channel?: "stable" | "beta" | "canary" | "dev";
};
export type BrowserConfig = {
  enabled?: boolean;
  /** If false, disable browser act:evaluate (arbitrary JS). Default: true */
  evaluateEnabled?: boolean;
  /** Base URL of the CDP endpoint (for remote browsers). Default: loopback CDP on the derived port. */
  cdpUrl?: string;
  /** Remote CDP HTTP timeout (ms). Default: 1500. */
  remoteCdpTimeoutMs?: number;
  /** Remote CDP WebSocket handshake timeout (ms). Default: max(remoteCdpTimeoutMs * 2, 2000). */
  remoteCdpHandshakeTimeoutMs?: number;
  /** Accent color for the openclaw browser profile (hex). Default: #FF4500 */
  color?: string;
  /** Override the browser executable path (all platforms). */
  executablePath?: string;
  /** Start Chrome headless (best-effort). Default: false */
  headless?: boolean;
  /** Pass --no-sandbox to Chrome (Linux containers). Default: false */
  noSandbox?: boolean;
  /** If true: never launch; only attach to an existing browser. Default: false */
  attachOnly?: boolean;
  /** Starting local CDP port for auto-assigned browser profiles. Default derives from gateway port. */
  cdpPortRangeStart?: number;
  /** Default profile to use when profile param is omitted. Default: "chrome" */
  defaultProfile?: string;
  /** Named browser profiles with explicit CDP ports or URLs. */
  profiles?: Record<string, BrowserProfileConfig>;
  /** Default snapshot options (applied by the browser tool/CLI when unset). */
  snapshotDefaults?: BrowserSnapshotDefaults;
  /** SSRF policy for browser navigation/open-tab operations. */
  ssrfPolicy?: BrowserSsrFPolicyConfig;
  /**
   * Additional Chrome launch arguments.
   * Useful for stealth flags, window size overrides, or custom user-agent strings.
   * Example: ["--window-size=1920,1080", "--disable-infobars"]
   */
  extraArgs?: string[];
  /** Chrome DevTools MCP server integration for agent sessions. */
  mcp?: BrowserMcpConfig;
  /**
   * Bind address for the Chrome extension relay server.
   * Default: "127.0.0.1". Set to "0.0.0.0" for WSL2 or other environments where
   * the relay must be reachable from a different network namespace.
   */
  relayBindHost?: string;
};
