import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadConfigMock,
  dispatcherDispatchMock,
  createBrowserRouteDispatcherMock,
  createBrowserControlContextMock,
  startBrowserControlServiceFromConfigMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  dispatcherDispatchMock: vi.fn(),
  createBrowserRouteDispatcherMock: vi.fn(() => ({
    dispatch: dispatcherDispatchMock,
  })),
  createBrowserControlContextMock: vi.fn(() => ({})),
  startBrowserControlServiceFromConfigMock: vi.fn(async () => true),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../node-command-policy.js", () => ({
  isNodeCommandAllowed: vi.fn(),
  resolveNodeCommandAllowlist: vi.fn(),
}));

vi.mock("../../browser/control-service.js", () => ({
  createBrowserControlContext: createBrowserControlContextMock,
  startBrowserControlServiceFromConfig: startBrowserControlServiceFromConfigMock,
}));

vi.mock("../../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: createBrowserRouteDispatcherMock,
}));

import { browserHandlers } from "./browser.js";

describe("browser.request local timeout forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({
      gateway: { nodes: { browser: { mode: "off" } } },
    });
  });

  it("passes an abort signal to local dispatch and times out cleanly", async () => {
    let observedSignal: AbortSignal | undefined;
    dispatcherDispatchMock.mockImplementationOnce(async ({ signal }: { signal?: AbortSignal }) => {
      observedSignal = signal;
      await new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    const respond = vi.fn();

    await browserHandlers["browser.request"]({
      params: {
        method: "POST",
        path: "/act",
        body: { kind: "click", ref: "e1" },
        timeoutMs: 5,
      },
      respond: respond as never,
      context: {
        nodeRegistry: {
          listConnected: () => [],
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-1", method: "browser.request" },
      isWebchatConnect: () => false,
    });

    expect(createBrowserRouteDispatcherMock).toHaveBeenCalled();
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("browser request timed out"),
      }),
    );
  });
});
