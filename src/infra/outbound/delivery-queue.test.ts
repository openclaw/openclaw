import { describe, expect, it } from "vitest";
import { isPermanentDeliveryError } from "./delivery-queue.js";

describe("isPermanentDeliveryError", () => {
  // Existing patterns
  it("detects 'chat not found'", () => {
    expect(isPermanentDeliveryError("chat not found")).toBe(true);
  });

  it("detects 'bot was blocked by the user'", () => {
    expect(isPermanentDeliveryError("bot was blocked by the user")).toBe(true);
  });

  // New HTTP 400 patterns
  it("detects 'message is too long'", () => {
    expect(isPermanentDeliveryError("Bad Request: message is too long")).toBe(true);
  });

  it("detects 'bad request' errors", () => {
    expect(isPermanentDeliveryError("bad request")).toBe(true);
  });

  it("detects 'invalid form body'", () => {
    expect(isPermanentDeliveryError("Invalid Form Body: content must be 2000 characters or fewer")).toBe(true);
  });

  // HTTP status code detection
  it("detects HTTP 400 from status pattern", () => {
    expect(isPermanentDeliveryError("Request failed with status 400")).toBe(true);
  });

  it("detects HTTP 403 from status code pattern", () => {
    expect(isPermanentDeliveryError("Status code: 403")).toBe(true);
  });

  it("detects HTTP 413 from status pattern", () => {
    expect(isPermanentDeliveryError("HTTP 413 Payload Too Large")).toBe(true);
  });

  // 429 should NOT be permanent (rate limit = transient)
  it("does NOT treat HTTP 429 as permanent", () => {
    expect(isPermanentDeliveryError("status 429")).toBe(false);
  });

  // 5xx should NOT be permanent (server error = transient)
  it("does NOT treat HTTP 500 as permanent", () => {
    expect(isPermanentDeliveryError("status 500")).toBe(false);
  });

  it("does NOT treat HTTP 502 as permanent", () => {
    expect(isPermanentDeliveryError("status 502")).toBe(false);
  });

  // Unrelated errors should not match
  it("returns false for transient network errors", () => {
    expect(isPermanentDeliveryError("ECONNREFUSED")).toBe(false);
  });

  it("returns false for timeout errors", () => {
    expect(isPermanentDeliveryError("request timed out")).toBe(false);
  });
});
