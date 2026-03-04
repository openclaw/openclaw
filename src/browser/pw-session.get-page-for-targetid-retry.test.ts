import { describe, expect, it, vi } from "vitest";
import { getPageForTargetIdWithRetry } from "./pw-session.js";

// Mock the underlying functions that are exported
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

    // Mock the exported functions
    const connectBrowserMock = vi.fn().mockResolvedValue({
      browser: { pages: vi.fn().mockResolvedValue([mockPage]) },
    });
    const getAllPagesMock = vi.fn().mockResolvedValue([mockPage]);
    const findPageByTargetIdMock = vi.fn().mockResolvedValue(mockPage);
    const forceDisconnectMock = vi.fn();

    // Override the mocks
    vi.mocked(connectBrowser).mockImplementation(connectBrowserMock);
    vi.mocked(getAllPages).mockImplementation(getAllPagesMock);
    vi.mocked(findPageByTargetId).mockImplementation(findPageByTargetIdMock);
    vi.mocked(forceDisconnectPlaywrightForTarget).mockImplementation(forceDisconnectMock);

    const result = await getPageForTargetIdWithRetry({
      cdpUrl: "ws://localhost:9222/devtools/browser/123",
      targetId: "target-123",
    });

    expect(result).toBe(mockPage);
    expect(forceDisconnectMock).not.toHaveBeenCalled();
  });

  it("retries once after tab not found error", async () => {
    const mockPage = { url: () => "https://example.com" };

    // First call returns null, second call returns page
    const findPageByTargetIdMock = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mockPage);

    const connectBrowserMock = vi.fn().mockResolvedValue({
      browser: { pages: vi.fn().mockResolvedValue([mockPage]) },
    });
    const getAllPagesMock = vi.fn().mockResolvedValue([mockPage]);
    const forceDisconnectMock = vi.fn();

    vi.mocked(connectBrowser).mockImplementation(connectBrowserMock);
    vi.mocked(getAllPages).mockImplementation(getAllPagesMock);
    vi.mocked(findPageByTargetId).mockImplementation(findPageByTargetIdMock);
    vi.mocked(forceDisconnectPlaywrightForTarget).mockImplementation(forceDisconnectMock);

    const result = await getPageForTargetIdWithRetry({
      cdpUrl: "ws://127.0.0.1:18791/cdp",
      targetId: "target-123",
    });

    expect(result).toBe(mockPage);
    expect(forceDisconnectMock).toHaveBeenCalledWith({
      cdpUrl: "ws://127.0.0.1:18791/cdp",
      targetId: "target-123",
      reason: "tab not found - retrying with fresh connection",
    });
    expect(findPageByTargetIdMock).toHaveBeenCalledTimes(2);
  });

  it("throws error after retry still fails", async () => {
    const mockPage = { url: () => "https://example.com" };

    const findPageByTargetIdMock = vi.fn().mockResolvedValue(null);
    const connectBrowserMock = vi.fn().mockResolvedValue({
      browser: { pages: vi.fn().mockResolvedValue([mockPage]) },
    });
    const getAllPagesMock = vi.fn().mockResolvedValue([mockPage]);
    const forceDisconnectMock = vi.fn();

    vi.mocked(connectBrowser).mockImplementation(connectBrowserMock);
    vi.mocked(getAllPages).mockImplementation(getAllPagesMock);
    vi.mocked(findPageByTargetId).mockImplementation(findPageByTargetIdMock);
    vi.mocked(forceDisconnectPlaywrightForTarget).mockImplementation(forceDisconnectMock);

    await expect(
      getPageForTargetIdWithRetry({
        cdpUrl: "ws://127.0.0.1:18791/cdp",
        targetId: "target-123",
      }),
    ).rejects.toThrow("tab not found");

    expect(forceDisconnectMock).toHaveBeenCalled();
    expect(findPageByTargetIdMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry for non-extension relay URLs", async () => {
    const mockPage = { url: () => "https://example.com" };

    const findPageByTargetIdMock = vi.fn().mockResolvedValue(null);
    const connectBrowserMock = vi.fn().mockResolvedValue({
      browser: { pages: vi.fn().mockResolvedValue([mockPage]) },
    });
    const getAllPagesMock = vi.fn().mockResolvedValue([mockPage]);
    const forceDisconnectMock = vi.fn();

    vi.mocked(connectBrowser).mockImplementation(connectBrowserMock);
    vi.mocked(getAllPages).mockImplementation(getAllPagesMock);
    vi.mocked(findPageByTargetId).mockImplementation(findPageByTargetIdMock);
    vi.mocked(forceDisconnectPlaywrightForTarget).mockImplementation(forceDisconnectMock);

    await expect(
      getPageForTargetIdWithRetry({
        cdpUrl: "ws://remote-server:9222/devtools/browser/123",
        targetId: "target-123",
      }),
    ).rejects.toThrow("tab not found");

    expect(forceDisconnectMock).not.toHaveBeenCalled();
  });

  it("uses single page fallback without retry", async () => {
    const mockPage = { url: () => "https://example.com" };

    const findPageByTargetIdMock = vi.fn().mockResolvedValue(null);
    const connectBrowserMock = vi.fn().mockResolvedValue({
      browser: { pages: vi.fn().mockResolvedValue([mockPage]) },
    });
    const getAllPagesMock = vi.fn().mockResolvedValue([mockPage]);
    const forceDisconnectMock = vi.fn();

    vi.mocked(connectBrowser).mockImplementation(connectBrowserMock);
    vi.mocked(getAllPages).mockImplementation(getAllPagesMock);
    vi.mocked(findPageByTargetId).mockImplementation(findPageByTargetIdMock);
    vi.mocked(forceDisconnectPlaywrightForTarget).mockImplementation(forceDisconnectMock);

    const result = await getPageForTargetIdWithRetry({
      cdpUrl: "ws://127.0.0.1:18791/cdp",
      targetId: "target-123",
    });

    // Should use single page fallback without retry
    expect(result).toBe(mockPage);
    expect(forceDisconnectMock).not.toHaveBeenCalled();
  });
});
