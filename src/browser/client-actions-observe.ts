import type { BrowserActionPathResult } from "./client-actions-types.js";
import { fetchBrowserJson } from "./client-fetch.js";
import type { BrowserConsoleMessage } from "./pw-session.js";

function buildProfileQuery(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : "";
}

export async function browserConsoleMessages(
  baseUrl: string,
  opts: { level?: string; targetId?: string; profile?: string } = {},
): Promise<{ ok: true; messages: BrowserConsoleMessage[]; targetId: string }> {
  const q = new URLSearchParams();
  if (opts.level) q.set("level", opts.level);
  if (opts.targetId) q.set("targetId", opts.targetId);
  if (opts.profile) q.set("profile", opts.profile);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return await fetchBrowserJson<{
    ok: true;
    messages: BrowserConsoleMessage[];
    targetId: string;
  }>(`${baseUrl}/console${suffix}`, { timeoutMs: 20000 });
}

export async function browserPdfSave(
  baseUrl: string,
  opts: { targetId?: string; profile?: string } = {},
): Promise<BrowserActionPathResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionPathResult>(`${baseUrl}/pdf${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}
