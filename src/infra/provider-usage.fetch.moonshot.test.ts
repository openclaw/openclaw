import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchMoonshotUsage } from "./provider-usage.fetch.moonshot.js";

describe("fetchMoonshotUsage", () => {
  it("prefers Kimi billing endpoint when available", async () => {
    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("kimi.gateway.billing")) {
        return makeResponse(200, {
          usages: [
            {
              detail: { limit: "100", used: "20" },
              limits: [
                {
                  window: { duration: 6, timeUnit: "TIME_UNIT_HOUR" },
                  detail: { limit: "50", used: "10" },
                },
              ],
            },
          ],
        });
      }
      return makeResponse(404, "not found");
    });

    const snapshot = await fetchMoonshotUsage("token", 5000, mockFetch as unknown as typeof fetch);

    expect(snapshot.provider).toBe("moonshot");
    expect(snapshot.plan).toBe("Kimi");
    expect(snapshot.windows.map((w) => w.label)).toEqual(["Cycle", "6h"]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to moonshot global balance endpoint when Kimi endpoint fails", async () => {
    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("kimi.gateway.billing")) {
        return makeResponse(404, "not found");
      }
      if (url.includes("api.moonshot.ai")) {
        return makeResponse(200, {
          data: {
            total_balance: 100,
            remaining_balance: 70,
            plan_name: "Global Pro",
          },
        });
      }
      return makeResponse(404, "not found");
    });

    const snapshot = await fetchMoonshotUsage("token", 5000, mockFetch as unknown as typeof fetch);

    expect(snapshot.error).toBeUndefined();
    expect(snapshot.plan).toBe("Global Pro");
    expect(snapshot.windows).toEqual([{ label: "Balance", usedPercent: 30 }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to CN endpoint when global endpoint fails", async () => {
    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("kimi.gateway.billing")) {
        return makeResponse(404, "not found");
      }
      if (url.includes("api.moonshot.ai")) {
        return makeResponse(404, "not found");
      }
      if (url.includes("api.moonshot.cn")) {
        return makeResponse(200, {
          total: 80,
          remaining: 20,
        });
      }
      return makeResponse(404, "not found");
    });

    const snapshot = await fetchMoonshotUsage("token", 5000, mockFetch as unknown as typeof fetch);

    expect(snapshot.error).toBeUndefined();
    expect(snapshot.plan).toBe("CN");
    expect(snapshot.windows).toEqual([{ label: "Balance", usedPercent: 75 }]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
