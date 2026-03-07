import { describe, expect, it, vi } from "vitest";

vi.mock("./control-service.js", () => ({
  createBrowserControlContext: vi.fn(() => ({})),
  startBrowserControlServiceFromConfig: vi.fn(async () => true),
}));

vi.mock("./routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: vi.fn(() => ({
    dispatch: vi.fn(async () => {
      throw new Error("timed out");
    }),
  })),
}));

import { fetchBrowserJson } from "./client-fetch.js";

describe("fetchBrowserJson timeout error mapping", () => {
  it("keeps local action timeout errors specific instead of reporting service outage", async () => {
    await expect(fetchBrowserJson("/act", { method: "POST", timeoutMs: 1234 })).rejects.toThrow(
      "Browser action timed out after 1234ms while the local browser control service remained reachable",
    );
    await expect(fetchBrowserJson("/act", { method: "POST", timeoutMs: 1234 })).rejects.toThrow(
      "Retry only after changing something concrete",
    );
  });
});
