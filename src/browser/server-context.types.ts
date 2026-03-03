import type { Server } from "node:http";
import type { RunningChrome } from "./chrome.js";
import type { BrowserTab } from "./client.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";

export type { BrowserTab };

/**
 * Firecrawl cloud browser session state.
 */
export type FirecrawlSessionState = {
  sessionId: string;
  cdpWebSocketUrl: string;
  liveViewUrl: string;
  expiresAt?: string;
};

/**
 * Runtime state for a single profile's Chrome instance.
 */
export type ProfileRuntimeState = {
  profile: ResolvedBrowserProfile;
  running: RunningChrome | null;
  /** Active Firecrawl cloud browser session (firecrawl driver only). */
  firecrawlSession?: FirecrawlSessionState | null;
  /** Sticky tab selection when callers omit targetId (keeps snapshot+act consistent). */
  lastTargetId?: string | null;
};

export type BrowserServerState = {
  server?: Server | null;
  port: number;
  resolved: ResolvedBrowserConfig;
  profiles: Map<string, ProfileRuntimeState>;
};

type BrowserProfileActions = {
  ensureBrowserAvailable: () => Promise<void>;
  ensureTabAvailable: (targetId?: string) => Promise<BrowserTab>;
  isHttpReachable: (timeoutMs?: number) => Promise<boolean>;
  isReachable: (timeoutMs?: number) => Promise<boolean>;
  listTabs: () => Promise<BrowserTab[]>;
  openTab: (url: string) => Promise<BrowserTab>;
  focusTab: (targetId: string) => Promise<void>;
  closeTab: (targetId: string) => Promise<void>;
  stopRunningBrowser: () => Promise<{ stopped: boolean }>;
  resetProfile: () => Promise<{ moved: boolean; from: string; to?: string }>;
};

export type BrowserRouteContext = {
  state: () => BrowserServerState;
  forProfile: (profileName?: string) => ProfileContext;
  listProfiles: () => Promise<ProfileStatus[]>;
  // Legacy methods delegate to default profile for backward compatibility
  mapTabError: (err: unknown) => { status: number; message: string } | null;
} & BrowserProfileActions;

export type ProfileContext = {
  profile: ResolvedBrowserProfile;
} & BrowserProfileActions;

export type ProfileStatus = {
  name: string;
  cdpPort: number;
  cdpUrl: string;
  color: string;
  running: boolean;
  tabCount: number;
  isDefault: boolean;
  isRemote: boolean;
};

export type ContextOptions = {
  getState: () => BrowserServerState | null;
  onEnsureAttachTarget?: (profile: ResolvedBrowserProfile) => Promise<void>;
  refreshConfigFromDisk?: boolean;
  /** Firecrawl API key for cloud browser sessions (resolved from config or env). */
  firecrawlApiKey?: string;
  /** Firecrawl base URL (default: https://api.firecrawl.dev). */
  firecrawlBaseUrl?: string;
};
