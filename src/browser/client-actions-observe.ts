import type {
  BrowserActionOk,
  BrowserActionPathResult,
} from "./client-actions-types.js";
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

export async function browserVerifyElementVisible(
  baseUrl: string,
  opts: { role: string; accessibleName: string; targetId?: string },
): Promise<BrowserActionOk> {
  return await fetchBrowserJson<BrowserActionOk>(`${baseUrl}/verify/element`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      role: opts.role,
      accessibleName: opts.accessibleName,
      targetId: opts.targetId,
    }),
    timeoutMs: 20000,
  });
}

export async function browserVerifyTextVisible(
  baseUrl: string,
  opts: { text: string; targetId?: string },
): Promise<BrowserActionOk> {
  return await fetchBrowserJson<BrowserActionOk>(`${baseUrl}/verify/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: opts.text, targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}

export async function browserVerifyListVisible(
  baseUrl: string,
  opts: { ref: string; items: string[]; targetId?: string },
): Promise<BrowserActionOk> {
  return await fetchBrowserJson<BrowserActionOk>(`${baseUrl}/verify/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: opts.ref,
      items: opts.items,
      targetId: opts.targetId,
    }),
    timeoutMs: 20000,
  });
}

export async function browserVerifyValue(
  baseUrl: string,
  opts: { ref: string; type: string; value?: string; targetId?: string },
): Promise<BrowserActionOk> {
  return await fetchBrowserJson<BrowserActionOk>(`${baseUrl}/verify/value`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: opts.ref,
      type: opts.type,
      value: opts.value,
      targetId: opts.targetId,
    }),
    timeoutMs: 20000,
  });
}

export async function browserMouseMove(
  baseUrl: string,
  opts: { x: number; y: number; targetId?: string },
): Promise<BrowserActionOk> {
  return await fetchBrowserJson<BrowserActionOk>(`${baseUrl}/mouse/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x: opts.x, y: opts.y, targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}

export async function browserMouseClick(
  baseUrl: string,
  opts: { x: number; y: number; button?: string; targetId?: string },
): Promise<BrowserActionOk> {
  return await fetchBrowserJson<BrowserActionOk>(`${baseUrl}/mouse/click`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      x: opts.x,
      y: opts.y,
      button: opts.button,
      targetId: opts.targetId,
    }),
    timeoutMs: 20000,
  });
}

export async function browserMouseDrag(
  baseUrl: string,
  opts: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    targetId?: string;
  },
): Promise<BrowserActionOk> {
  return await fetchBrowserJson<BrowserActionOk>(`${baseUrl}/mouse/drag`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startX: opts.startX,
      startY: opts.startY,
      endX: opts.endX,
      endY: opts.endY,
      targetId: opts.targetId,
    }),
    timeoutMs: 20000,
  });
}
