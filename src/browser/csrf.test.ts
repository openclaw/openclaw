import { describe, expect, it } from "vitest";
import { shouldRejectBrowserMutation } from "./csrf.js";

describe("browser CSRF loopback mutation guard", () => {
  it("rejects mutating methods from non-loopback origin", () => {
    expect(
      shouldRejectBrowserMutation({
        method: "POST",
        origin: "https://evil.example",
      }),
    ).toBe(true);
  });

  it("allows mutating methods from loopback origin", () => {
    expect(
      shouldRejectBrowserMutation({
        method: "POST",
        origin: "http://127.0.0.1:18789",
      }),
    ).toBe(false);

    expect(
      shouldRejectBrowserMutation({
        method: "POST",
        origin: "http://localhost:18789",
      }),
    ).toBe(false);
  });

  it("allows mutating methods without origin/referer (non-browser clients)", () => {
    expect(
      shouldRejectBrowserMutation({
        method: "POST",
      }),
    ).toBe(false);
  });

  it("rejects mutating methods with origin=null", () => {
    expect(
      shouldRejectBrowserMutation({
        method: "POST",
        origin: "null",
      }),
    ).toBe(true);
  });

  it("rejects mutating methods from non-loopback referer", () => {
    expect(
      shouldRejectBrowserMutation({
        method: "POST",
        referer: "https://evil.example/attack",
      }),
    ).toBe(true);
  });

  it("rejects cross-site mutations via Sec-Fetch-Site when present", () => {
    expect(
      shouldRejectBrowserMutation({
        method: "POST",
        secFetchSite: "cross-site",
      }),
    ).toBe(true);
  });

  it("does not reject non-mutating methods", () => {
    expect(
      shouldRejectBrowserMutation({
        method: "GET",
        origin: "https://evil.example",
      }),
    ).toBe(false);

    expect(
      shouldRejectBrowserMutation({
        method: "OPTIONS",
        origin: "https://evil.example",
      }),
    ).toBe(false);
  });
});
