import { describe, expect, it, vi } from "vitest";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
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
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(goto).toHaveBeenCalledWith("https://example.com", { timeout: 1000 });
    expect(result.url).toBe("https://example.com");
  });

  it("reconnects and retries once when navigation detaches frame", async () => {
    const goto = vi
      .fn<(...args: unknown[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("page.goto: Frame has been detached"))
      .mockResolvedValueOnce(undefined);
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "https://example.com/recovered"),
    });

    const result = await mod.navigateViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      url: "https://example.com/recovered",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(getPwToolsCoreSessionMocks().getPageForTargetId).toHaveBeenCalledTimes(2);
    expect(getPwToolsCoreSessionMocks().forceDisconnectPlaywrightForTarget).toHaveBeenCalledTimes(
      1,
    );
    expect(getPwToolsCoreSessionMocks().forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      reason: "retry navigate after detached frame",
    });
    expect(goto).toHaveBeenCalledTimes(2);
    expect(result.url).toBe("https://example.com/recovered");
  });

  it("blocks private intermediate redirect hops during navigation", async () => {
    const goto = vi.fn(async () => ({
      request: () => ({
        url: () => "https://93.184.216.34/final",
        redirectedFrom: () => ({
          url: () => "http://127.0.0.1:18080/internal-hop",
          redirectedFrom: () => ({
            url: () => "https://93.184.216.34/start",
            redirectedFrom: () => null,
          }),
        }),
      }),
    }));
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "https://93.184.216.34/final"),
    });

    await expect(
      mod.navigateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        url: "https://93.184.216.34/start",
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);

    expect(goto).toHaveBeenCalledTimes(1);
  });

  it("does not retry navigation after the request aborts", async () => {
    const ctrl = new AbortController();
    const goto = vi.fn(async () => {
      ctrl.abort(new Error("navigate aborted"));
      throw new Error("Target page, context or browser has been closed");
    });
    setPwToolsCoreCurrentPage({
      goto,
      url: vi.fn(() => "https://example.com/aborted"),
    });

    await expect(
      mod.navigateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "tab-1",
        url: "https://example.com/aborted",
        ssrfPolicy: { allowPrivateNetwork: true },
        signal: ctrl.signal,
      }),
    ).rejects.toThrow("navigate aborted");

    expect(goto).toHaveBeenCalledTimes(1);
    expect(getPwToolsCoreSessionMocks().getPageForTargetId).toHaveBeenCalledTimes(1);
    expect(
      getPwToolsCoreSessionMocks().forceDisconnectPlaywrightForTarget,
    ).not.toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "tab-1",
      reason: "retry navigate after detached frame",
    });
  });

  it("does not start the first navigation once the request is already aborted", async () => {
    const ctrl = new AbortController();
    const goto = vi.fn(async () => {});
    getPwToolsCoreSessionMocks().getPageForTargetId.mockImplementationOnce(async () => {
      ctrl.abort(new Error("navigate aborted before goto"));
      return {
        goto,
        url: vi.fn(() => "https://example.com/aborted"),
      };
    });

    await expect(
      mod.navigateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "tab-1",
        url: "https://example.com/aborted",
        ssrfPolicy: { allowPrivateNetwork: true },
        signal: ctrl.signal,
      }),
    ).rejects.toThrow("navigate aborted before goto");

    expect(goto).not.toHaveBeenCalled();
  });
});
