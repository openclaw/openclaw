import type { BrowserActionOk, BrowserActionTargetOk } from "./client-actions-types.js";
import { fetchBrowserJson } from "./client-fetch.js";

function buildProfileQuery(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : "";
}

export async function browserCookies(
  baseUrl: string,
  opts: { targetId?: string; profile?: string } = {},
): Promise<{ ok: true; targetId: string; cookies: unknown[] }> {
  const q = new URLSearchParams();
  if (opts.targetId) q.set("targetId", opts.targetId);
  if (opts.profile) q.set("profile", opts.profile);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return await fetchBrowserJson<{
    ok: true;
    targetId: string;
    cookies: unknown[];
  }>(`${baseUrl}/cookies${suffix}`, { timeoutMs: 20000 });
}

export async function browserCookiesSet(
  baseUrl: string,
  opts: {
    cookie: Record<string, unknown>;
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(`${baseUrl}/cookies/set${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId, cookie: opts.cookie }),
    timeoutMs: 20000,
  });
}

export async function browserCookiesClear(
  baseUrl: string,
  opts: { targetId?: string; profile?: string } = {},
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(`${baseUrl}/cookies/clear${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}

export async function browserStorageGet(
  baseUrl: string,
  opts: {
    kind: "local" | "session";
    key?: string;
    targetId?: string;
    profile?: string;
  },
): Promise<{ ok: true; targetId: string; values: Record<string, string> }> {
  const q = new URLSearchParams();
  if (opts.targetId) q.set("targetId", opts.targetId);
  if (opts.key) q.set("key", opts.key);
  if (opts.profile) q.set("profile", opts.profile);
  const suffix = q.toString() ? `?${q.toString()}` : "";
  return await fetchBrowserJson<{
    ok: true;
    targetId: string;
    values: Record<string, string>;
  }>(`${baseUrl}/storage/${opts.kind}${suffix}`, { timeoutMs: 20000 });
}

export async function browserStorageSet(
  baseUrl: string,
  opts: {
    kind: "local" | "session";
    key: string;
    value: string;
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(`${baseUrl}/storage/${opts.kind}/set${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: opts.targetId,
      key: opts.key,
      value: opts.value,
    }),
    timeoutMs: 20000,
  });
}

export async function browserStorageClear(
  baseUrl: string,
  opts: { kind: "local" | "session"; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(
    `${baseUrl}/storage/${opts.kind}/clear${q}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId: opts.targetId }),
      timeoutMs: 20000,
    },
  );
}

export async function browserSetOffline(
  baseUrl: string,
  opts: { offline: boolean; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(`${baseUrl}/set/offline${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId, offline: opts.offline }),
    timeoutMs: 20000,
  });
}

export async function browserSetHeaders(
  baseUrl: string,
  opts: {
    headers: Record<string, string>;
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(`${baseUrl}/set/headers${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId, headers: opts.headers }),
    timeoutMs: 20000,
  });
}

export async function browserSetHttpCredentials(
  baseUrl: string,
  opts: {
    username?: string;
    password?: string;
    clear?: boolean;
    targetId?: string;
    profile?: string;
  } = {},
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(`${baseUrl}/set/credentials${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: opts.targetId,
      username: opts.username,
      password: opts.password,
      clear: opts.clear,
    }),
    timeoutMs: 20000,
  });
}

export async function browserSetGeolocation(
  baseUrl: string,
  opts: {
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    origin?: string;
    clear?: boolean;
    targetId?: string;
    profile?: string;
  } = {},
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(`${baseUrl}/set/geolocation${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: opts.targetId,
      latitude: opts.latitude,
      longitude: opts.longitude,
      accuracy: opts.accuracy,
      origin: opts.origin,
      clear: opts.clear,
    }),
    timeoutMs: 20000,
  });
}

export async function browserSetMedia(
  baseUrl: string,
  opts: {
    colorScheme: "dark" | "light" | "no-preference" | "none";
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(`${baseUrl}/set/media${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: opts.targetId,
      colorScheme: opts.colorScheme,
    }),
    timeoutMs: 20000,
  });
}

export async function browserSetTimezone(
  baseUrl: string,
  opts: { timezoneId: string; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(`${baseUrl}/set/timezone${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: opts.targetId,
      timezoneId: opts.timezoneId,
    }),
    timeoutMs: 20000,
  });
}

export async function browserSetLocale(
  baseUrl: string,
  opts: { locale: string; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(`${baseUrl}/set/locale${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId, locale: opts.locale }),
    timeoutMs: 20000,
  });
}

export async function browserSetDevice(
  baseUrl: string,
  opts: { name: string; targetId?: string; profile?: string },
): Promise<BrowserActionTargetOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTargetOk>(`${baseUrl}/set/device${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId, name: opts.name }),
    timeoutMs: 20000,
  });
}

export async function browserClearPermissions(
  baseUrl: string,
  opts: { targetId?: string; profile?: string } = {},
): Promise<BrowserActionOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionOk>(`${baseUrl}/set/geolocation${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId, clear: true }),
    timeoutMs: 20000,
  });
}
