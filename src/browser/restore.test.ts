import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContextLock } from "../config/sessions/types.js";
import type { ShopConfig } from "../config/types.agent-defaults.js";

// Mock the external dependencies before importing the module under test.
vi.mock("./control-service.js", () => ({
  createBrowserControlContext: vi.fn(),
}));

vi.mock("./cdp.js", () => ({
  getDomText: vi.fn(),
}));

vi.mock("./shop-validation.js", () => ({
  resolveShopConfig: vi.fn(),
  validateShopIdentity: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

import { getDomText } from "./cdp.js";
import { createBrowserControlContext } from "./control-service.js";
import { restoreBrowserContext } from "./restore.js";
import { resolveShopConfig } from "./shop-validation.js";

const mockCreateBrowserControlContext = vi.mocked(createBrowserControlContext);
const mockGetDomText = vi.mocked(getDomText);
const mockResolveShopConfig = vi.mocked(resolveShopConfig);

function makeLock(overrides?: Partial<ContextLock>): ContextLock {
  return {
    shopKey: "bigmk",
    browserProfile: "tt-3bigmk",
    activeTabId: "tab-123",
    pageUrl: "https://seller-ph.tiktok.com/compass/data-overview?shop_region=PH",
    lockedAt: Date.now() - 60_000,
    ttlMs: 30 * 60 * 1000,
    lockVersion: 1,
    ...overrides,
  };
}

function makeShops(): Record<string, ShopConfig> {
  return {
    bigmk: {
      shopName: "bigmk.ph",
      shopCode: "PHLCSLWL2G",
      profile: "tt-3bigmk",
      platform: "tiktok",
    },
  };
}

function makeProfileContext(opts?: {
  tabs?: Array<{ targetId: string; url: string; wsUrl?: string; type?: string }>;
  ensureFail?: string;
  focusFail?: boolean;
  openTabFail?: string;
}) {
  const tabs = opts?.tabs ?? [
    {
      targetId: "tab-123",
      url: "https://seller-ph.tiktok.com/compass/data-overview?shop_region=PH",
      wsUrl: "ws://127.0.0.1:18801/devtools/page/tab-123",
      type: "page",
    },
  ];
  return {
    ensureBrowserAvailable: opts?.ensureFail
      ? vi.fn().mockRejectedValue(new Error(opts.ensureFail))
      : vi.fn().mockResolvedValue(undefined),
    listTabs: vi.fn().mockResolvedValue(tabs),
    focusTab: opts?.focusFail
      ? vi.fn().mockRejectedValue(new Error("tab not found"))
      : vi.fn().mockResolvedValue(undefined),
    openTab: opts?.openTabFail
      ? vi.fn().mockRejectedValue(new Error(opts.openTabFail))
      : vi.fn().mockImplementation(async (url: string) => ({
          targetId: "new-tab-456",
          url,
          wsUrl: "ws://127.0.0.1:18801/devtools/page/new-tab-456",
          type: "page",
        })),
    ensureTabAvailable: vi.fn().mockResolvedValue(tabs[0]),
    closeTab: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

describe("restoreBrowserContext", () => {
  it("restores active tab and validates shop via shopCode in page text", async () => {
    const profileCtx = makeProfileContext();
    mockCreateBrowserControlContext.mockReturnValue({
      forProfile: () => profileCtx,
    } as any);
    mockResolveShopConfig.mockReturnValue({
      ok: true,
      shopKey: "bigmk",
      config: makeShops().bigmk,
    });
    mockGetDomText.mockResolvedValue({ text: "Dashboard ... PHLCSLWL2G ... sales data" });

    const result = await restoreBrowserContext({ lock: makeLock(), shops: makeShops() });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tabId).toBe("tab-123");
    }
    expect(profileCtx.ensureBrowserAvailable).toHaveBeenCalled();
    expect(profileCtx.focusTab).toHaveBeenCalledWith("tab-123");
  });

  it("restores active tab and validates via shopName in page text", async () => {
    const profileCtx = makeProfileContext();
    mockCreateBrowserControlContext.mockReturnValue({
      forProfile: () => profileCtx,
    } as any);
    mockResolveShopConfig.mockReturnValue({
      ok: true,
      shopKey: "bigmk",
      config: makeShops().bigmk,
    });
    mockGetDomText.mockResolvedValue({ text: "Welcome to bigmk.ph seller center" });

    const result = await restoreBrowserContext({ lock: makeLock(), shops: makeShops() });
    expect(result.ok).toBe(true);
  });

  it("restores via shopKey-derived name in page text", async () => {
    const profileCtx = makeProfileContext();
    mockCreateBrowserControlContext.mockReturnValue({
      forProfile: () => profileCtx,
    } as any);
    mockResolveShopConfig.mockReturnValue({
      ok: true,
      shopKey: "bigmk",
      config: makeShops().bigmk,
    });
    mockGetDomText.mockResolvedValue({ text: "Bigmk ecommerce inc0612 dashboard" });

    const result = await restoreBrowserContext({ lock: makeLock(), shops: makeShops() });
    expect(result.ok).toBe(true);
  });

  it("fails when page text has no shop identifiers", async () => {
    const profileCtx = makeProfileContext();
    mockCreateBrowserControlContext.mockReturnValue({
      forProfile: () => profileCtx,
    } as any);
    mockResolveShopConfig.mockReturnValue({
      ok: true,
      shopKey: "bigmk",
      config: makeShops().bigmk,
    });
    mockGetDomText.mockResolvedValue({ text: "Some other shop completely" });

    const result = await restoreBrowserContext({ lock: makeLock(), shops: makeShops() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("shop_mismatch");
    }
  });

  it("falls back to pageUrl when activeTabId is stale", async () => {
    const profileCtx = makeProfileContext({ tabs: [], focusFail: true });
    mockCreateBrowserControlContext.mockReturnValue({
      forProfile: () => profileCtx,
    } as any);
    mockResolveShopConfig.mockReturnValue({
      ok: true,
      shopKey: "bigmk",
      config: makeShops().bigmk,
    });
    mockGetDomText.mockResolvedValue({ text: "PHLCSLWL2G" });

    const result = await restoreBrowserContext({ lock: makeLock(), shops: makeShops() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tabId).toBe("new-tab-456");
    }
    expect(profileCtx.openTab).toHaveBeenCalledWith(
      "https://seller-ph.tiktok.com/compass/data-overview?shop_region=PH",
    );
  });

  it("fails when browser profile is unavailable", async () => {
    const profileCtx = makeProfileContext({ ensureFail: "Chrome not installed" });
    mockCreateBrowserControlContext.mockReturnValue({
      forProfile: () => profileCtx,
    } as any);

    const result = await restoreBrowserContext({ lock: makeLock(), shops: makeShops() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Failed to start browser");
    }
  });

  it("skips shop validation when no shops config is provided", async () => {
    const profileCtx = makeProfileContext();
    mockCreateBrowserControlContext.mockReturnValue({
      forProfile: () => profileCtx,
    } as any);

    const result = await restoreBrowserContext({ lock: makeLock() });
    expect(result.ok).toBe(true);
    expect(mockGetDomText).not.toHaveBeenCalled();
  });

  it("skips page validation when tab has no wsUrl", async () => {
    const profileCtx = makeProfileContext({
      tabs: [{ targetId: "tab-123", url: "https://seller-ph.tiktok.com/homepage" }],
    });
    mockCreateBrowserControlContext.mockReturnValue({
      forProfile: () => profileCtx,
    } as any);
    mockResolveShopConfig.mockReturnValue({
      ok: true,
      shopKey: "bigmk",
      config: makeShops().bigmk,
    });

    const result = await restoreBrowserContext({ lock: makeLock(), shops: makeShops() });
    expect(result.ok).toBe(true);
    expect(mockGetDomText).not.toHaveBeenCalled();
  });

  it("succeeds when getDomText throws (best-effort validation)", async () => {
    const profileCtx = makeProfileContext();
    mockCreateBrowserControlContext.mockReturnValue({
      forProfile: () => profileCtx,
    } as any);
    mockResolveShopConfig.mockReturnValue({
      ok: true,
      shopKey: "bigmk",
      config: makeShops().bigmk,
    });
    mockGetDomText.mockRejectedValue(new Error("CDP connection reset"));

    const result = await restoreBrowserContext({ lock: makeLock(), shops: makeShops() });
    expect(result.ok).toBe(true);
  });

  it("fails when browser control context throws for unknown profile", async () => {
    mockCreateBrowserControlContext.mockReturnValue({
      forProfile: () => {
        throw new Error('Profile "bad-profile" not found');
      },
    } as any);

    const result = await restoreBrowserContext({
      lock: makeLock({ browserProfile: "bad-profile" }),
      shops: makeShops(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not available");
    }
  });
});
