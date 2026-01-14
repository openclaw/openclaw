import type { CDPSession, Page } from "playwright-core";
import { devices as playwrightDevices } from "playwright-core";

import { ensurePageState, getPageForTargetId } from "./pw-session.js";

async function withCdpSession<T>(page: Page, fn: (session: CDPSession) => Promise<T>): Promise<T> {
  const session = await page.context().newCDPSession(page);
  try {
    return await fn(session);
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function setOfflineViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  offline: boolean;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.context().setOffline(Boolean(opts.offline));
}

export async function setExtraHTTPHeadersViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  headers: Record<string, string>;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.context().setExtraHTTPHeaders(opts.headers);
}

export async function setHttpCredentialsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  username?: string;
  password?: string;
  clear?: boolean;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  if (opts.clear) {
    await page.context().setHTTPCredentials(null);
    return;
  }
  const username = String(opts.username ?? "");
  const password = String(opts.password ?? "");
  if (!username) throw new Error("username is required (or set clear=true)");
  await page.context().setHTTPCredentials({ username, password });
}

export async function setGeolocationViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  origin?: string;
  clear?: boolean;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const context = page.context();
  if (opts.clear) {
    await context.setGeolocation(null);
    await context.clearPermissions().catch(() => {});
    return;
  }
  if (typeof opts.latitude !== "number" || typeof opts.longitude !== "number") {
    throw new Error("latitude and longitude are required (or set clear=true)");
  }
  await context.setGeolocation({
    latitude: opts.latitude,
    longitude: opts.longitude,
    accuracy: typeof opts.accuracy === "number" ? opts.accuracy : undefined,
  });
  const origin =
    opts.origin?.trim() ||
    (() => {
      try {
        return new URL(page.url()).origin;
      } catch {
        return "";
      }
    })();
  if (origin) {
    await context.grantPermissions(["geolocation"], { origin }).catch(() => {});
  }
}

export async function emulateMediaViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  colorScheme: "dark" | "light" | "no-preference" | null;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.emulateMedia({ colorScheme: opts.colorScheme });
}

export async function setLocaleViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  locale: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const locale = String(opts.locale ?? "").trim();
  if (!locale) throw new Error("locale is required");
  await withCdpSession(page, async (session) => {
    try {
      await session.send("Emulation.setLocaleOverride", { locale });
    } catch (err) {
      if (String(err).includes("Another locale override is already in effect")) {
        return;
      }
      throw err;
    }
  });
}

export async function setTimezoneViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timezoneId: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const timezoneId = String(opts.timezoneId ?? "").trim();
  if (!timezoneId) throw new Error("timezoneId is required");
  await withCdpSession(page, async (session) => {
    try {
      await session.send("Emulation.setTimezoneOverride", { timezoneId });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("Timezone override is already in effect")) return;
      if (msg.includes("Invalid timezone")) throw new Error(`Invalid timezone ID: ${timezoneId}`);
      throw err;
    }
  });
}

export async function setDeviceViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  name: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const name = String(opts.name ?? "").trim();
  if (!name) throw new Error("device name is required");
  const descriptor = (playwrightDevices as Record<string, unknown>)[name] as
    | {
        userAgent?: string;
        viewport?: { width: number; height: number };
        deviceScaleFactor?: number;
        isMobile?: boolean;
        hasTouch?: boolean;
        locale?: string;
      }
    | undefined;
  if (!descriptor) {
    throw new Error(`Unknown device "${name}".`);
  }

  if (descriptor.viewport) {
    await page.setViewportSize({
      width: descriptor.viewport.width,
      height: descriptor.viewport.height,
    });
  }

  await withCdpSession(page, async (session) => {
    if (descriptor.userAgent || descriptor.locale) {
      await session.send("Emulation.setUserAgentOverride", {
        userAgent: descriptor.userAgent ?? "",
        acceptLanguage: descriptor.locale ?? undefined,
      });
    }
    if (descriptor.viewport) {
      await session.send("Emulation.setDeviceMetricsOverride", {
        mobile: Boolean(descriptor.isMobile),
        width: descriptor.viewport.width,
        height: descriptor.viewport.height,
        deviceScaleFactor: descriptor.deviceScaleFactor ?? 1,
        screenWidth: descriptor.viewport.width,
        screenHeight: descriptor.viewport.height,
      });
    }
    if (descriptor.hasTouch) {
      await session.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
      });
    }
  });
}
