/**
 * P1-1: Browser context restore after model switch.
 *
 * When a model switch occurs and a contextLock is active, this module
 * performs the actual browser restore:
 *   1. Ensure browser profile is available
 *   2. Activate saved tab or navigate to saved pageUrl
 *   3. Extract page text and validate shop identity
 *   4. Bump lock version on success, clear lock on failure
 */
import type { ContextLock } from "../config/sessions/types.js";
import type { ShopConfig } from "../config/types.agent-defaults.js";
import { logWarn } from "../logger.js";
import { getDomText } from "./cdp.js";
import { createBrowserControlContext } from "./control-service.js";
import { resolveShopConfig, validateShopIdentity } from "./shop-validation.js";

export type BrowserRestoreResult =
  | { ok: true; tabId: string; url: string }
  | { ok: false; error: string };

/**
 * Restore browser context from a contextLock after model switch.
 *
 * Steps:
 *   1. Switch to lock.browserProfile (ensure browser available)
 *   2. Activate lock.activeTabId if alive, else open lock.pageUrl
 *   3. Extract page text, validate shop identity
 *   4. Return ok/fail — caller bumps or clears the lock accordingly
 */
export async function restoreBrowserContext(params: {
  lock: ContextLock;
  shops?: Record<string, ShopConfig>;
}): Promise<BrowserRestoreResult> {
  const { lock, shops } = params;

  // 1. Get profile context from browser control service.
  let ctx: ReturnType<ReturnType<typeof createBrowserControlContext>["forProfile"]>;
  try {
    const browserCtx = createBrowserControlContext();
    ctx = browserCtx.forProfile(lock.browserProfile);
  } catch (err) {
    return {
      ok: false,
      error: `Browser profile "${lock.browserProfile}" not available: ${String(err)}`,
    };
  }

  // 2. Ensure browser is running.
  try {
    await ctx.ensureBrowserAvailable();
  } catch (err) {
    return {
      ok: false,
      error: `Failed to start browser for profile "${lock.browserProfile}": ${String(err)}`,
    };
  }

  // 3. Activate saved tab or open pageUrl.
  let activeTab: { targetId: string; url: string; wsUrl?: string } | null = null;

  // Try to find and focus the saved tab.
  if (lock.activeTabId) {
    try {
      const tabs = await ctx.listTabs();
      const found = tabs.find((t) => t.targetId === lock.activeTabId);
      if (found) {
        await ctx.focusTab(found.targetId);
        activeTab = found;
      }
    } catch {
      // Tab not found or stale — will fall through to pageUrl.
    }
  }

  // If no saved tab or it wasn't found, navigate to pageUrl.
  if (!activeTab && lock.pageUrl) {
    try {
      activeTab = await ctx.openTab(lock.pageUrl);
    } catch (err) {
      return { ok: false, error: `Failed to open tab for ${lock.pageUrl}: ${String(err)}` };
    }
  }

  // If neither activeTabId nor pageUrl worked, try to get any existing tab.
  if (!activeTab) {
    try {
      activeTab = await ctx.ensureTabAvailable();
    } catch (err) {
      return {
        ok: false,
        error: `No usable tab for profile "${lock.browserProfile}": ${String(err)}`,
      };
    }
  }

  // 4. Validate shop identity via page text (best-effort).
  //    If no shops config is available, skip validation and succeed.
  if (!shops) {
    logWarn(`[context-lock:restore] No shops config — skipping shop validation, proceeding`);
    return { ok: true, tabId: activeTab.targetId, url: activeTab.url };
  }

  const shopResolved = resolveShopConfig(shops, lock.shopKey);
  if (!shopResolved.ok) {
    return { ok: false, error: `Shop config error: ${shopResolved.error}` };
  }

  // Try to read page text for validation.
  if (!activeTab.wsUrl) {
    // No WebSocket URL (remote profile or extension) — skip page validation.
    logWarn(`[context-lock:restore] No wsUrl for tab — skipping page shop validation`);
    return { ok: true, tabId: activeTab.targetId, url: activeTab.url };
  }

  try {
    // Wait briefly for page to settle after tab activation/navigation.
    await new Promise<void>((r) => setTimeout(r, 1500));

    const { text } = await getDomText({
      wsUrl: activeTab.wsUrl,
      format: "text",
      maxChars: 50_000,
    });

    // Extract shop identity from page text.
    // On TikTok Seller Center, the shopCode may appear in page text or URL.
    // The shopName (e.g. "bigmk.ph") or account name (e.g. "Bigmk ecommerce inc0612")
    // should be present on most pages.
    const pageText = text || "";
    const config = shopResolved.config;

    // Check 1: shopCode in page text (strictest).
    const hasShopCode = pageText.includes(config.shopCode);

    // Check 2: shopName in page text.
    const hasShopName = pageText.toLowerCase().includes(config.shopName.toLowerCase());

    // Check 3: shopKey-derived name in page text (e.g. "bigmk" → "Bigmk").
    const hasShopKeyName = pageText.toLowerCase().includes(lock.shopKey.toLowerCase());

    if (hasShopCode || hasShopName || hasShopKeyName) {
      return { ok: true, tabId: activeTab.targetId, url: activeTab.url };
    }

    // None of the identifiers found — this is a mismatch.
    const error =
      `shop_mismatch: page text does not contain shopCode="${config.shopCode}", ` +
      `shopName="${config.shopName}", or shopKey="${lock.shopKey}"`;
    logWarn(`[context-lock:restore] ${error}`);
    return { ok: false, error };
  } catch (err) {
    // Page text extraction failed — proceed with a warning rather than failing.
    logWarn(
      `[context-lock:restore] Page text extraction failed: ${String(err)} — proceeding anyway`,
    );
    return { ok: true, tabId: activeTab.targetId, url: activeTab.url };
  }
}
