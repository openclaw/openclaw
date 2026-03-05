import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(async () => ({ status: 200, body: { ok: true } })),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({
      gateway: {
        auth: {
          token: "loopback-token",
        },
      },
    })),
  };
});

vi.mock("./control-service.js", () => ({
  createBrowserControlContext: vi.fn(() => ({})),
  startBrowserControlServiceFromConfig: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: vi.fn(() => ({
    dispatch: mocks.dispatch,
  })),
}));

import { fetchBrowserJson } from "./client-fetch.js";

describe("fetchBrowserJson error mapping", () => {
  beforeEach(() => {
    mocks.dispatch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves actionable application errors", async () => {
    mocks.dispatch.mockResolvedValue({
      status: 400,
      body: { error: "fields are required" },
    });

    try {
      await fetchBrowserJson("/act", { method: "POST" });
      throw new Error("expected fetchBrowserJson to throw");
    } catch (err) {
      const message = String(err);
      expect(message).toContain("fields are required");
      expect(message).not.toContain("Can't reach the OpenClaw browser control service");
    }
  });

  it("still wraps connectivity failures", async () => {
    mocks.dispatch.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:18800"));

    await expect(fetchBrowserJson("/act", { method: "POST" })).rejects.toThrow(
      /Can't reach the OpenClaw browser control service/i,
    );
  });
});
