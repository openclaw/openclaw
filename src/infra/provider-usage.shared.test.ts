import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { clampPercent, raceUsageTimeout, resolveUsageProviderId } from "./provider-usage.shared.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  { value: "unknown-provider", expected: "unknown-provider" },
  { value: "minimax-portal", expected: "minimax" },
  { value: "minimax-cn", expected: "minimax" },
  { value: "minimax-portal-cn", expected: "minimax" },
  { value: " CLAUDE-CLI ", expected: "anthropic" },
  { value: undefined, expected: undefined },
])("normalizes provider ids for %j", ({ value, expected }) => {
  expect(resolveUsageProviderId(value)).toBe(expected);
});

it("maps only OpenAI subscription credentials to usage windows", () => {
  expect(resolveUsageProviderId("openai", { credentialType: "oauth" })).toBe("openai");
  expect(resolveUsageProviderId("openai", { credentialType: "token" })).toBe("openai");
  expect(resolveUsageProviderId("openai", { credentialType: "api_key" })).toBeUndefined();
});

it("treats non-finite usage percentages as zero", () => {
  expect(clampPercent(Number.NaN)).toBe(0);
});

it("clears the timeout after successful work", async () => {
  vi.useFakeTimers();
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
  await expect(raceUsageTimeout(async () => "ok", 100, "fallback")).resolves.toBe("ok");
  expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
});

it("clamps oversized timeout delays before returning the fallback", async () => {
  vi.useFakeTimers();
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
  const result = raceUsageTimeout(
    () => new Promise<string>(() => {}),
    Number.MAX_SAFE_INTEGER,
    "fallback",
  );
  expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
  await expect(result).resolves.toBe("fallback");
});
