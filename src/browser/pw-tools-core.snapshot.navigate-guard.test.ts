import { describe, expect, it, vi } from "vitest";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import {
  getPwToolsCoreSessionMocks,
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();
const mod = await import("./pw-tools-core.snapshot.js");

describe("pw-tools-core.snapshot navigate guard", () => {
  it("blocks unsupported non-network URLs before page lookup", async () => {
    const goto = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "about:blank"),
    });

    await expect(
      mod.navigateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "file:///etc/passwd",
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);

    expect(getPwToolsCoreSessionMocks().getPageForTargetId).not.toHaveBeenCalled();
    expect(goto).not.toHaveBeenCalled();
  });

  it("navigates valid network URLs with clamped timeout", async () => {
    const goto = vi.fn(async () => {});
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "https://example.com"),
    });

    const result = await mod.navigateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      url: "https://example.com",
      timeoutMs: 10,
    });

    expect(goto).toHaveBeenCalledWith("https://example.com", { timeout: 1000 });
    expect(result.url).toBe("https://example.com");
  });
});
