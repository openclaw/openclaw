import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({
    gateway: {
      auth: {
        token: "loopback-token",
      },
    },
  })),
  startBrowserControlServiceFromConfig: vi.fn(async () => true),
  createBrowserControlContext: vi.fn(() => ({})),
  dispatch: vi.fn(async () => ({ status: 200, body: { ok: true } })),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("./control-service.js", () => ({
  createBrowserControlContext: mocks.createBrowserControlContext,
  startBrowserControlServiceFromConfig: mocks.startBrowserControlServiceFromConfig,
}));

vi.mock("./routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: vi.fn(() => ({
    dispatch: mocks.dispatch,
  })),
}));

import { fetchBrowserJson } from "./client-fetch.js";

describe("fetchBrowserJson error classification", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.loadConfig.mockClear();
    mocks.startBrowserControlServiceFromConfig.mockClear();
    mocks.createBrowserControlContext.mockClear();
    mocks.dispatch.mockReset();
    mocks.dispatch.mockResolvedValue({ status: 200, body: { ok: true } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves local browser route errors without wrapping as service outage", async () => {
    mocks.dispatch.mockResolvedValueOnce({
      status: 500,
      body: { error: "TimeoutError: locator.click: Timeout 8000ms exceeded." },
    });

    let thrown: unknown;
    try {
      await fetchBrowserJson("/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "click", ref: "e1" }),
        timeoutMs: 200,
      });
    } catch (err) {
      thrown = err;
    }

    const message = String(thrown);
    expect(message).toContain("locator.click");
    expect(message).not.toContain("Can't reach the OpenClaw browser control service");
  });

  it("uses bounded-retry guidance for action-path timeouts", async () => {
    mocks.dispatch.mockImplementationOnce(
      () =>
        new Promise<never>(() => {
          // Intentionally unresolved to trigger fetchBrowserJson timeout path.
        }),
    );

    await expect(
      fetchBrowserJson("/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "click", ref: "e1" }),
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/Do NOT blindly retry in a loop/);
  });

  it("keeps strict non-retry guidance for non-action path timeouts", async () => {
    mocks.dispatch.mockImplementationOnce(
      () =>
        new Promise<never>(() => {
          // Intentionally unresolved to trigger fetchBrowserJson timeout path.
        }),
    );

    await expect(
      fetchBrowserJson("/tabs", {
        method: "GET",
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/Do NOT retry the browser tool — it will keep failing/);
  });

  it("preserves HTTP response errors from reachable browser service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("tab not found", {
            status: 404,
            headers: { "Content-Type": "text/plain" },
          }),
      ),
    );

    let thrown: unknown;
    try {
      await fetchBrowserJson("http://127.0.0.1:18888/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "click", ref: "e1" }),
        timeoutMs: 200,
      });
    } catch (err) {
      thrown = err;
    }

    const message = String(thrown);
    expect(message).toContain("tab not found");
    expect(message).not.toContain("Can't reach the OpenClaw browser control service");
  });
});
