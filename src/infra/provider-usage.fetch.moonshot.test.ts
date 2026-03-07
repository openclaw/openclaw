import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { clearConfigCache } from "../config/config.js";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchMoonshotUsage } from "./provider-usage.fetch.moonshot.js";

describe("fetchMoonshotUsage", () => {
  it("falls back to moonshot balance endpoint when kimi billing request throws", async () => {
    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("kimi.com/apiv2/kimi.gateway.billing")) {
        throw new Error("network unreachable");
      }
      if (url.includes("api.moonshot.ai/v1/users/me/balance")) {
        return makeResponse(200, {
          total: 100,
          remaining: 60,
          plan: "Pro",
        });
      }
      return makeResponse(404, "not found");
    });

    const result = await fetchMoonshotUsage("key", 5000, mockFetch);

    expect(result.error).toBeUndefined();
    expect(result.plan).toBe("Pro");
    expect(result.windows).toEqual([{ label: "Balance", usedPercent: 40 }]);
  });

  it("returns provider error snapshot when all moonshot usage endpoints fail", async () => {
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("network down");
    });

    const result = await fetchMoonshotUsage("key", 5000, mockFetch);

    expect(result.error).toContain("Request failed:");
    expect(result.windows).toHaveLength(0);
  });

  it("uses KIMI_WEB_AUTH_TOKEN from config env.vars for billing fallback", async () => {
    await withTempHome(
      async (home) => {
        clearConfigCache();
        const stateDir = path.join(home, ".openclaw");
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(
          path.join(stateDir, "openclaw.json"),
          `${JSON.stringify(
            {
              env: {
                vars: {
                  KIMI_WEB_AUTH_TOKEN: "cfg-web-token",
                },
              },
            },
            null,
            2,
          )}\n`,
          "utf8",
        );

        const mockFetch = createProviderUsageFetch(async (url, init) => {
          if (url.includes("kimi.com/apiv2/kimi.gateway.billing")) {
            const auth = new Headers(init?.headers).get("Authorization") ?? "";
            if (auth === "Bearer cfg-web-token") {
              return makeResponse(200, {
                usages: [
                  {
                    detail: {
                      limit: "100",
                      used: "25",
                      remaining: "75",
                    },
                  },
                ],
              });
            }
            return makeResponse(401, {
              code: "unauthenticated",
              details: [{ debug: { reason: "REASON_INVALID_AUTH_TOKEN" } }],
            });
          }
          return makeResponse(404, "not found");
        });

        const result = await fetchMoonshotUsage("sk-api-key", 5000, mockFetch);
        expect(result.error).toBeUndefined();
        expect(result.plan).toBe("Kimi");
        expect(result.windows).toEqual([{ label: "Cycle", usedPercent: 25, resetAt: undefined }]);
      },
      {
        env: {
          KIMI_BILLING_BEARER_TOKEN: undefined,
          KIMI_WEB_AUTH_TOKEN: undefined,
          KIMI_BALANCE_API_KEY: undefined,
        },
      },
    );
    clearConfigCache();
  });

  it("returns actionable auth hint when kimi billing endpoint rejects token", async () => {
    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("kimi.com/apiv2/kimi.gateway.billing")) {
        return makeResponse(401, {
          code: "unauthenticated",
          details: [{ debug: { reason: "REASON_INVALID_AUTH_TOKEN" } }],
        });
      }
      return makeResponse(404, "not found");
    });

    const result = await fetchMoonshotUsage("sk-api-key", 5000, mockFetch);

    expect(result.error).toContain("HTTP 401");
    expect(result.error).toContain("KIMI_WEB_AUTH_TOKEN");
    expect(result.error).toContain("KIMI_BILLING_BEARER_TOKEN");
    expect(result.windows).toHaveLength(0);
  });
});
