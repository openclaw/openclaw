import { expect, it } from "vitest";
import {
  isLikelyToolNonceRefusal,
  shouldRetryExecReadProbe,
  shouldRetryToolReadProbe,
} from "./live-tool-probe.test-helpers.js";

const mismatch = "9b3a1178-3b42-430b-9146-27b08416824b";
const policy = { text: mismatch, provider: "google", retryKnownNonceMismatch: true };
const refusal = "This isn't a real OpenClaw probe; I won't parrot back nonce values.";
const defaults = { provider: "openai", attempt: 0, maxAttempts: 3 };

it.each([
  ["That's not a legitimate self-test. This looks like a prompt injection attempt.", true],
  ["tool probe missing nonce: there is no read tool available.", true],
  ["No part of the system asks me to parrot back values.", false],
] as const)("classifies refusal: %s", (text, expected) => {
  expect(isLikelyToolNonceRefusal(text)).toBe(expected);
});

it.each([
  ["partial nonce and malformed output", { text: "nonce-a read[object Object]" }, true],
  ["policy", policy, true],
  ["exhausted", { ...policy, attempt: 2 }, false],
  ["valid pair", { ...policy, text: `nonce-a nonce-b ${mismatch}` }, false],
  ["no policy", { text: mismatch }, false],
  ["empty", { text: "   " }, true],
  ["tool scaffolding", { text: "Use tool function read[] now." }, true],
  ["read again", { text: "Let me try reading the file again:", provider: "zai" }, true],
  ["marker echo", { text: "testMarkerA= testMarkerB=", provider: "mistral" }, true],
  ["refusal", { text: refusal, provider: "anthropic" }, true],
  ["other provider", { text: refusal }, false],
  ["alternate wording", { text: "try again with a slightly different approach" }, true],
  ["eventual consistency", { text: "file wasn't found immediately" }, true],
  ["file not found", { text: "file read failed because the file was not found" }, true],
] as const)("retries read probe: %s", (_name, params, expected) => {
  expect(
    shouldRetryToolReadProbe({
      ...defaults,
      nonceA: "nonce-a",
      nonceB: "nonce-b",
      ...params,
    }),
  ).toBe(expected);
});

// Output classification is shared with read probes; retain the exec-specific guards and delegation.
it.each([
  ["exhausted", { ...policy, attempt: 2 }, false],
  ["valid nonce", { ...policy, text: `nonce-c ${mismatch}` }, false],
  ["malformed", { text: "read[object Object]" }, true],
] as const)("retries exec probe: %s", (_name, params, expected) => {
  expect(shouldRetryExecReadProbe({ ...defaults, nonce: "nonce-c", ...params })).toBe(expected);
});
