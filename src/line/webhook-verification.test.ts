import { describe, expect, it } from "vitest";
import { isLineVerificationProbe, parseLineWebhookBody } from "./webhook-verification.js";

describe("parseLineWebhookBody", () => {
  it("parses valid JSON payloads", () => {
    const parsed = parseLineWebhookBody(JSON.stringify({ events: [{ type: "message" }] }));
    expect(parsed).toBeTruthy();
    expect(parsed?.events?.length).toBe(1);
  });

  it("returns null for invalid payloads", () => {
    expect(parseLineWebhookBody("not-json")).toBeNull();
  });
});

describe("isLineVerificationProbe", () => {
  it("returns true for empty events arrays", () => {
    expect(isLineVerificationProbe({ events: [] })).toBe(true);
  });

  it("returns false for non-empty events", () => {
    expect(isLineVerificationProbe({ events: [{ type: "message" }] })).toBe(false);
  });
});
