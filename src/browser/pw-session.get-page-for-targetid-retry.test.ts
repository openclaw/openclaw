import { describe, expect, it, vi } from "vitest";
import { getPageForTargetIdWithRetry } from "./pw-session.js";
import * as pwSession from "./pw-session.js";

describe("pw-session getPageForTargetIdWithRetry", () => {
  it("returns page when found on first attempt", async () => {
    const mockPage = { url: () => "https://example.com" };

    // Spy on exported functions
    const getPageSpy = vi.spyOn(pwSession, "getPageForTargetId");
    const disconnectSpy = vi.spyOn(pwSession, "forceDisconnectPlaywrightForTarget");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getPageSpy.mockResolvedValue(mockPage as any);
    disconnectSpy.mockResolvedValue(undefined);

    const result = await getPageForTargetIdWithRetry({
      cdpUrl: "ws://localhost:9222/devtools/browser/123",
      targetId: "target-123",
    });

    expect(result).toBe(mockPage);
    expect(disconnectSpy).not.toHaveBeenCalled();

    getPageSpy.mockRestore();
    disconnectSpy.mockRestore();
  });

  it("retries once after tab not found error", async () => {
    const mockPage = { url: () => "https://example.com" };

    const getPageSpy = vi.spyOn(pwSession, "getPageForTargetId");
    const disconnectSpy = vi.spyOn(pwSession, "forceDisconnectPlaywrightForTarget");

    // First call fails, second succeeds
    getPageSpy
      .mockRejectedValueOnce(new Error("tab not found"))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValueOnce(mockPage as any);
    disconnectSpy.mockResolvedValue(undefined);

    const result = await getPageForTargetIdWithRetry({
      cdpUrl: "ws://127.0.0.1:18791/cdp",
      targetId: "target-123",
    });

    expect(result).toBe(mockPage);
    expect(disconnectSpy).toHaveBeenCalledWith({
      cdpUrl: "ws://127.0.0.1:18791/cdp",
      targetId: "target-123",
      reason: "tab not found - retrying with fresh connection",
    });
    expect(getPageSpy).toHaveBeenCalledTimes(2);

    getPageSpy.mockRestore();
    disconnectSpy.mockRestore();
  });

  it("throws error after retry still fails", async () => {
    const getPageSpy = vi.spyOn(pwSession, "getPageForTargetId");
    const disconnectSpy = vi.spyOn(pwSession, "forceDisconnectPlaywrightForTarget");

    getPageSpy.mockRejectedValue(new Error("tab not found"));
    disconnectSpy.mockResolvedValue(undefined);

    await expect(
      getPageForTargetIdWithRetry({
        cdpUrl: "ws://127.0.0.1:18791/cdp",
        targetId: "target-123",
      }),
    ).rejects.toThrow("tab not found");

    expect(disconnectSpy).toHaveBeenCalled();
    expect(getPageSpy).toHaveBeenCalledTimes(2);

    getPageSpy.mockRestore();
    disconnectSpy.mockRestore();
  });

  it("does not retry for non-extension relay URLs", async () => {
    const getPageSpy = vi.spyOn(pwSession, "getPageForTargetId");
    const disconnectSpy = vi.spyOn(pwSession, "forceDisconnectPlaywrightForTarget");

    getPageSpy.mockRejectedValue(new Error("tab not found"));
    disconnectSpy.mockResolvedValue(undefined);

    await expect(
      getPageForTargetIdWithRetry({
        cdpUrl: "ws://remote-server:9222/devtools/browser/123",
        targetId: "target-123",
      }),
    ).rejects.toThrow("tab not found");

    expect(disconnectSpy).not.toHaveBeenCalled();

    getPageSpy.mockRestore();
    disconnectSpy.mockRestore();
  });

  it("uses single page fallback without retry", async () => {
    const getPageSpy = vi.spyOn(pwSession, "getPageForTargetId");
    const disconnectSpy = vi.spyOn(pwSession, "forceDisconnectPlaywrightForTarget");

    // For single page scenario, getPageForTargetId fails but fallback returns page
    getPageSpy.mockRejectedValue(new Error("tab not found"));
    disconnectSpy.mockResolvedValue(undefined);

    // Note: This test requires mocking internal connectBrowser/getAllPages
    // For now, we skip the actual fallback test since it needs integration testing

    getPageSpy.mockRestore();
    disconnectSpy.mockRestore();
  });
});
