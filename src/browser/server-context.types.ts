import type { Server } from "node:http";
import type { RunningChrome } from "./chrome.js";
import type { BrowserTab } from "./client.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";

export type { BrowserTab };

/**
 * Metadata tracked per tab for ownership and lifecycle management.
 * The `ownerId` field is an opaque string supplied by callers (e.g. an agent
 * session id).  The browser server never interprets it — it simply stores and
 * returns it so that callers can query and clean up tabs they own.
 */
export type TabMeta = {
  targetId: string;
  url: string;
  openedAt: number;
  lastAccessedAt: number;
  /** Opaque caller-supplied identifier for the owner of this tab. */
  ownerId?: string;
  /** Opaque caller-supplied identifier for whoever last accessed this tab. */
  lastAccessedBy?: string;
};

/**
 * Runtime state for a single profile's Chrome instance.
 */
export type ProfileRuntimeState = {
  profile: ResolvedBrowserProfile;
  running: RunningChrome | null;
  /** Sticky tab selection when callers omit targetId (keeps snapshot+act consistent). */
  lastTargetId?: string | null;
  /** Registry tracking ownership and access metadata for managed tabs. */
  tabRegistry?: Map<string, TabMeta>;
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
  openTab: (url: string, ownerId?: string) => Promise<BrowserTab>;
  focusTab: (targetId: string) => Promise<void>;
  closeTab: (targetId: string) => Promise<void>;
  closeTabsByOwner: (ownerId: string) => Promise<{ closed: string[] }>;
  stopRunningBrowser: () => Promise<{ stopped: boolean }>;
  resetProfile: () => Promise<{ moved: boolean; from: string; to?: string }>;
  getTabRegistry: () => Map<string, TabMeta>;
  touchTab: (targetId: string, accessedBy?: string) => void;
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
};
