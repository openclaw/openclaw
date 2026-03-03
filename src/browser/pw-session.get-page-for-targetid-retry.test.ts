import { describe, expect, it, vi } from "vitest";
import { getPageForTargetIdWithRetry } from "./pw-session.js";

// Mock the underlying functions
vi.mock("./pw-session.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    connectBrowser: vi.fn(),
    getAllPages: vi.fn(),
    findPageByTargetId: vi.fn(),
    forceDisconnectPlaywrightForTarget: vi.fn(),
  };
});

describe("pw-session getPageForTargetIdWithRetry", () => {
  it("returns page when found on first attempt", async () => {
    const mockPage = { url: () => "https://example.com" };
    const mockBrowser = { pages: vi.fn().mockResolvedValue([mockPage]) };

    // @ts-expect-error mock
    connectBrowser.mockResolvedValue({ browser: mockBrowser });
    // @ts-expect-error mock
    getAllPages.mockResolvedValue([mockPage]);
    // @ts-expect-error mock
    findPageByTargetId.mockResolvedValue(mockPage);

    const result = await getPageForTargetIdWithRetry({
      cdpUrl: "ws://localhost:9222/devtools/browser/123",
      targetId: "target-123",
    });

    expect(result).toBe(mockPage);
    expect(forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();
  });

  it("retries once after tab not found error", async () => {
    const mockPage = { url: () => "https://example.com" };
    const mockBrowser = { pages: vi.fn().mockResolvedValue([mockPage]) };

    // @ts-expect-error mock
    connectBrowser.mockResolvedValue({ browser: mockBrowser });
    // @ts-expect-error mock
    getAllPages.mockResolvedValue([mockPage]);
    // @ts-expect-error mock - first call returns null, second call returns page
    findPageByTargetId.mockResolvedValueOnce(null).mockResolvedValueOnce(mockPage);
    // @ts-expect-error mock
    forceDisconnectPlaywrightForTarget.mockResolvedValue(undefined);

    const result = await getPageForTargetIdWithRetry({
      cdpUrl: "ws://localhost:9222/devtools/browser/123",
      targetId: "target-123",
    });

    expect(result).toBe(mockPage);
    expect(forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      cdpUrl: "ws://localhost:9222/devtools/browser/123",
      targetId: "target-123",
      reason: "tab not found - retrying with fresh connection",
    });
    expect(findPageByTargetId).toHaveBeenCalledTimes(2);
  });

  it("throws error after retry still fails", async () => {
    const mockPage = { url: () => "https://example.com" };
    const mockBrowser = { pages: vi.fn().mockResolvedValue([mockPage]) };

    // @ts-expect-error mock
    connectBrowser.mockResolvedValue({ browser: mockBrowser });
    // @ts-expect-error mock
    getAllPages.mockResolvedValue([mockPage]);
    // @ts-expect-error mock - both calls return null
    findPageByTargetId.mockResolvedValue(null);
    // @ts-expect-error mock
    forceDisconnectPlaywrightForTarget.mockResolvedValue(undefined);

    await expect(
      getPageForTargetIdWithRetry({
        cdpUrl: "ws://localhost:9222/devtools/browser/123",
        targetId: "target-123",
      }),
    ).rejects.toThrow("tab not found");

    expect(forceDisconnectPlaywrightForTarget).toHaveBeenCalled();
    expect(findPageByTargetId).toHaveBeenCalledTimes(2);
  });

  it("does not retry for single page fallback", async () => {
    const mockPage = { url: () => "https://example.com" };
    const mockBrowser = { pages: vi.fn().mockResolvedValue([mockPage]) };

    // @ts-expect-error mock
    connectBrowser.mockResolvedValue({ browser: mockBrowser });
    // @ts-expect-error mock
    getAllPages.mockResolvedValue([mockPage]);
    // @ts-expect-error mock
    findPageByTargetId.mockResolvedValue(null);

    // This should use the single page fallback and not retry
    const result = await getPageForTargetIdWithRetry({
      cdpUrl: "ws://localhost:9222/devtools/browser/123",
      targetId: "target-123",
    });

    expect(result).toBe(mockPage);
    expect(forceDisconnectPlaywrightForTarget).not.toHaveBeenCalled();
  });
});
