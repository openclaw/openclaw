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

  it("retries when tool output is empty and attempts remain", () => {
    expect(
      shouldRetryToolReadProbe({
        text: "   ",
        nonceA: "nonce-a",
        nonceB: "nonce-b",
        provider: "openai",
        attempt: 0,
        maxAttempts: 3,
      }),
    ).toBe(true);
  });

  it("retries when output still looks like tool/function scaffolding", () => {
    expect(
      shouldRetryToolReadProbe({
        text: "Use tool function read[] now.",
        nonceA: "nonce-a",
        nonceB: "nonce-b",
        provider: "openai",
        attempt: 0,
        maxAttempts: 3,
      }),
    ).toBe(true);
  });

  it("retries mistral nonce marker echoes without parsed nonce values", () => {
    expect(
      shouldRetryToolReadProbe({
        text: "nonceA= nonceB=",
        nonceA: "nonce-a",
        nonceB: "nonce-b",
        provider: "mistral",
        attempt: 0,
        maxAttempts: 3,
      }),
    ).toBe(true);
  });

  it("does not retry nonce marker echoes for non-mistral providers", () => {
    expect(
      shouldRetryToolReadProbe({
        text: "nonceA= nonceB=",
        nonceA: "nonce-a",
        nonceB: "nonce-b",
        provider: "openai",
        attempt: 0,
        maxAttempts: 3,
      }),
    ).toBe(false);
  });
});
