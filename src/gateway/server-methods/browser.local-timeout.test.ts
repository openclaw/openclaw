import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBrowserControlContext: vi.fn(() => ({})),
  createBrowserRouteDispatcher: vi.fn(),
  isNodeCommandAllowed: vi.fn(),
  loadConfig: vi.fn(),
  resolveNodeCommandAllowlist: vi.fn(),
  startBrowserControlServiceFromConfig: vi.fn(),
}));

vi.mock("../../browser/control-service.js", () => ({
  createBrowserControlContext: mocks.createBrowserControlContext,
  startBrowserControlServiceFromConfig: mocks.startBrowserControlServiceFromConfig,
}));

vi.mock("../../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: mocks.createBrowserRouteDispatcher,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../node-command-policy.js", () => ({
  isNodeCommandAllowed: mocks.isNodeCommandAllowed,
  resolveNodeCommandAllowlist: mocks.resolveNodeCommandAllowlist,
}));

import { browserHandlers } from "./browser.js";

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

describe("browser.request local timeout handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({
      gateway: { nodes: { browser: { mode: "auto" } } },
    });
    mocks.resolveNodeCommandAllowlist.mockReturnValue([]);
    mocks.isNodeCommandAllowed.mockReturnValue({ ok: true });
    mocks.startBrowserControlServiceFromConfig.mockResolvedValue(true);
  });

  it("passes an AbortSignal into local dispatch and returns a timeout error", async () => {
    const dispatch = vi.fn(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason ?? new Error("aborted"));
            return;
          }
          const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
    );
    mocks.createBrowserRouteDispatcher.mockReturnValue({ dispatch });

    const respond = vi.fn();
    await browserHandlers["browser.request"]({
      params: {
        method: "POST",
        path: "/act",
        body: { kind: "click", ref: "e1" },
        timeoutMs: 10,
      },
      respond: respond as never,
      context: {
        nodeRegistry: {
          listConnected: vi.fn(() => []),
        },
      } as never,
      client: null,
      req: { type: "req", id: "req-1", method: "browser.request" },
      isWebchatConnect: () => false,
    });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/act",
        signal: expect.any(AbortSignal),
      }),
    );
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.message).toContain("browser request timed out");
  });
});
