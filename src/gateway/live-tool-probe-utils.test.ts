import { describe, expect, it } from "vitest";
import { hasExpectedToolNonce, shouldRetryToolReadProbe } from "./live-tool-probe-utils.js";

describe("live tool probe utils", () => {
  it("matches nonce pair when both are present", () => {
    expect(hasExpectedToolNonce("value a-1 and b-2", "a-1", "b-2")).toBe(true);
    expect(hasExpectedToolNonce("value a-1 only", "a-1", "b-2")).toBe(false);
  });

  it("retries malformed tool output when attempts remain", () => {
    expect(
      shouldRetryToolReadProbe({
        text: "read[object Object],[object Object]",
        nonceA: "nonce-a",
        nonceB: "nonce-b",
        provider: "mistral",
        attempt: 0,
        maxAttempts: 3,
      }),
    ).toBe(true);
  });

  it("does not retry once max attempts are exhausted", () => {
    expect(
      shouldRetryToolReadProbe({
        text: "read[object Object],[object Object]",
        nonceA: "nonce-a",
        nonceB: "nonce-b",
        provider: "mistral",
        attempt: 2,
        maxAttempts: 3,
      }),
    ).toBe(false);
  });

  it("does not retry when nonce pair is already present", () => {
    expect(
      shouldRetryToolReadProbe({
        text: "nonce-a nonce-b",
        nonceA: "nonce-a",
        nonceB: "nonce-b",
        provider: "mistral",
        attempt: 0,
        maxAttempts: 3,
      }),
    ).toBe(false);
  });
});
