// Verifies marketplace feed and source profile config parsing.
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

function expectMarketplacesConfig(value: unknown) {
  const result = OpenClawSchema.safeParse(value);
  if (!result.success) {
    throw new Error(JSON.stringify(result.error.issues, null, 2));
  }
  return result.data.marketplaces;
}

describe("OpenClawSchema marketplaces config", () => {
  it("accepts hosted feed and local source profiles", () => {
    const marketplaces = expectMarketplacesConfig({
      marketplaces: {
        feeds: {
          "clawhub-public": {
            url: "https://clawhub.ai/v1/feeds/plugins",
            verification: { mode: "unsigned" },
          },
          acme: {
            url: "https://packages.acme.example/openclaw/feed",
            verification: { mode: "unsigned" },
          },
        },
        sources: {
          "public-clawhub": { type: "clawhub" },
          "public-npm": { type: "npm" },
          "acme-npm": { type: "npm" },
          "acme-clawhub": { type: "clawhub" },
          "acme-git": { type: "git" },
        },
      },
    });

    expect(marketplaces?.feeds?.acme.url).toBe("https://packages.acme.example/openclaw/feed");
    expect(marketplaces?.sources?.["acme-git"].type).toBe("git");
  });

  it.each([
    "http://packages.acme.example/openclaw/feed",
    "https://token@packages.acme.example/openclaw/feed",
    "https://user:pass@packages.acme.example/openclaw/feed",
    "https://packages.acme.example/openclaw/feed?token=secret",
    "https://packages.acme.example/openclaw/feed#access-token",
    "not a url",
  ])("rejects invalid or auth-bearing hosted feed URL %s without throwing", (url) => {
    expect(() =>
      OpenClawSchema.safeParse({
        marketplaces: {
          feeds: { acme: { url } },
        },
      }),
    ).not.toThrow();
    const result = OpenClawSchema.safeParse({
      marketplaces: {
        feeds: { acme: { url } },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
        "marketplaces.feeds.acme.url",
      );
    }
  });

  it("rejects refresh, auth, and signed verification until loader enforcement exists", () => {
    expect(
      OpenClawSchema.safeParse({
        marketplaces: {
          feeds: {
            acme: {
              url: "https://packages.acme.example/openclaw/feed",
              auth: { scheme: "bearer", secret: "token" },
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      OpenClawSchema.safeParse({
        marketplaces: {
          feeds: {
            acme: {
              url: "https://packages.acme.example/openclaw/feed",
              refresh: { onStartup: "if-stale" },
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      OpenClawSchema.safeParse({
        marketplaces: {
          feeds: {
            acme: {
              url: "https://packages.acme.example/openclaw/feed",
              verification: { mode: "signed" },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown source profile types", () => {
    const result = OpenClawSchema.safeParse({
      marketplaces: {
        sources: { acme: { type: "container" } },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects source endpoints until installer resolution can enforce them", () => {
    const result = OpenClawSchema.safeParse({
      marketplaces: {
        sources: {
          "acme-npm": { type: "npm", registry: "https://packages.acme.example/npm/" },
          "acme-clawhub": { type: "clawhub", baseUrl: "https://packages.acme.example/clawhub/" },
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
