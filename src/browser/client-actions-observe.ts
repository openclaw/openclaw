import type { BrowserActionPathResult } from "./client-actions-types.js";
import { fetchBrowserJson } from "./client-fetch.js";
import type { BrowserConsoleMessage } from "./pw-session.js";

export async function browserConsoleMessages(
  baseUrl: string,
  opts: { level?: string; targetId?: string } = {},
): Promise<{ ok: true; messages: BrowserConsoleMessage[]; targetId: string }> {
  const q = new URLSearchParams();
  if (opts.level) q.set("level", opts.level);
  if (opts.targetId) q.set("targetId", opts.targetId);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return await fetchBrowserJson<{
    ok: true;
    messages: BrowserConsoleMessage[];
    targetId: string;
  }>(`${baseUrl}/console${suffix}`, { timeoutMs: 20000 });
}

export async function browserPdfSave(
  baseUrl: string,
  opts: { targetId?: string } = {},
): Promise<BrowserActionPathResult> {
  return await fetchBrowserJson<BrowserActionPathResult>(`${baseUrl}/pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}
