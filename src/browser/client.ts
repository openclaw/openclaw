import { loadConfig } from "../config/config.js";
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

export type ScreenshotResult = {
  ok: true;
  path: string;
  targetId: string;
  url: string;
};

async function fetchJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? 5000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await fetch(url, { ...init, signal: ctrl.signal } as RequestInit);
  clearTimeout(t);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text ? `${res.status}: ${text}` : `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function resolveBrowserControlUrl(overrideUrl?: string) {
  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser);
  const url = overrideUrl?.trim() ? overrideUrl.trim() : resolved.controlUrl;
  return url.replace(/\/$/, "");
}

export async function browserStatus(baseUrl: string): Promise<BrowserStatus> {
  return await fetchJson<BrowserStatus>(`${baseUrl}/`, { timeoutMs: 1500 });
}

export async function browserStart(baseUrl: string): Promise<void> {
  await fetchJson(`${baseUrl}/start`, { method: "POST", timeoutMs: 15000 });
}

export async function browserStop(baseUrl: string): Promise<void> {
  await fetchJson(`${baseUrl}/stop`, { method: "POST", timeoutMs: 15000 });
}

export async function browserTabs(baseUrl: string): Promise<BrowserTab[]> {
  const res = await fetchJson<{ running: boolean; tabs: BrowserTab[] }>(
    `${baseUrl}/tabs`,
    { timeoutMs: 3000 },
  );
  return res.tabs ?? [];
}

export async function browserOpenTab(
  baseUrl: string,
  url: string,
): Promise<BrowserTab> {
  return await fetchJson<BrowserTab>(`${baseUrl}/tabs/open`, {
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
  await fetchJson(`${baseUrl}/tabs/focus`, {
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
  await fetchJson(`${baseUrl}/tabs/${encodeURIComponent(targetId)}`, {
    method: "DELETE",
    timeoutMs: 5000,
  });
}

export async function browserScreenshot(
  baseUrl: string,
  opts: {
    targetId?: string;
    fullPage?: boolean;
  },
): Promise<ScreenshotResult> {
  const q = new URLSearchParams();
  if (opts.targetId) q.set("targetId", opts.targetId);
  if (opts.fullPage) q.set("fullPage", "true");
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return await fetchJson<ScreenshotResult>(`${baseUrl}/screenshot${suffix}`, {
    timeoutMs: 20000,
  });
}
