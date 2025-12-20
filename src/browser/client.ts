import { loadConfig } from "../config/config.js";
import { fetchBrowserJson } from "./client-fetch.js";
import { resolveBrowserConfig } from "./config.js";

export type BrowserStatus = {
  enabled: boolean;
  controlUrl: string;
  running: boolean;
  pid: number | null;
  cdpPort: number;
  chosenBrowser: string | null;
  userDataDir: string | null;
  color: string;
  headless: boolean;
  attachOnly: boolean;
};

export type BrowserTab = {
  targetId: string;
  title: string;
  url: string;
  type?: string;
};

export type SnapshotAriaNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  backendDOMNodeId?: number;
  depth: number;
};

export type SnapshotResult =
  | {
      ok: true;
      format: "aria";
      targetId: string;
      url: string;
      nodes: SnapshotAriaNode[];
    }
  | {
      ok: true;
      format: "ai";
      targetId: string;
      url: string;
      snapshot: string;
    };

export function resolveBrowserControlUrl(overrideUrl?: string) {
  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser);
  const url = overrideUrl?.trim() ? overrideUrl.trim() : resolved.controlUrl;
  return url.replace(/\/$/, "");
}

export async function browserStatus(baseUrl: string): Promise<BrowserStatus> {
  return await fetchBrowserJson<BrowserStatus>(`${baseUrl}/`, {
    timeoutMs: 1500,
  });
}

export async function browserStart(baseUrl: string): Promise<void> {
  await fetchBrowserJson(`${baseUrl}/start`, {
    method: "POST",
    timeoutMs: 15000,
  });
}

export async function browserStop(baseUrl: string): Promise<void> {
  await fetchBrowserJson(`${baseUrl}/stop`, {
    method: "POST",
    timeoutMs: 15000,
  });
}

export async function browserTabs(baseUrl: string): Promise<BrowserTab[]> {
  const res = await fetchBrowserJson<{ running: boolean; tabs: BrowserTab[] }>(
    `${baseUrl}/tabs`,
    { timeoutMs: 3000 },
  );
  return res.tabs ?? [];
}

export async function browserOpenTab(
  baseUrl: string,
  url: string,
): Promise<BrowserTab> {
  return await fetchBrowserJson<BrowserTab>(`${baseUrl}/tabs/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    timeoutMs: 15000,
  });
}

export async function browserFocusTab(
  baseUrl: string,
  targetId: string,
): Promise<void> {
  await fetchBrowserJson(`${baseUrl}/tabs/focus`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId }),
    timeoutMs: 5000,
  });
}

export async function browserCloseTab(
  baseUrl: string,
  targetId: string,
): Promise<void> {
  await fetchBrowserJson(`${baseUrl}/tabs/${encodeURIComponent(targetId)}`, {
    method: "DELETE",
    timeoutMs: 5000,
  });
}

export async function browserSnapshot(
  baseUrl: string,
  opts: {
    format: "aria" | "ai";
    targetId?: string;
    limit?: number;
  },
): Promise<SnapshotResult> {
  const q = new URLSearchParams();
  q.set("format", opts.format);
  if (opts.targetId) q.set("targetId", opts.targetId);
  if (typeof opts.limit === "number") q.set("limit", String(opts.limit));
  return await fetchBrowserJson<SnapshotResult>(
    `${baseUrl}/snapshot?${q.toString()}`,
    {
      timeoutMs: 20000,
    },
  );
}

// Actions beyond the basic read-only commands live in client-actions.ts.
