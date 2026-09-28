import { expect, it } from "vitest";
import { resolveChatErrorKindFromError } from "./server-chat.js";

it.each([
  ["groq tpm 413", new Error("Request too large: too many tokens per minute (TPM)"), "rate_limit"],
  ["quota exceeded", new Error("quota exceeded"), "rate_limit"],
  ["resource_exhausted", new Error("resource_exhausted"), "rate_limit"],
  ["http 429", Object.assign(new Error("Too many requests"), { code: 429 }), "rate_limit"],
  ["fetch failed", new Error("fetch failed"), "timeout"],
  ["socket hang up", new Error("socket hang up"), "timeout"],
  ["etimedout", Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }), "timeout"],
  ["context overflow", new Error("context length exceeded"), "context_length"],
  ["refusal_policy", new Error("Unhandled stop reason: refusal_policy"), "refusal"],
  ["content_filter", new Error("content_filter blocked the response"), "refusal"],
  ["plain error", new Error("plain provider failure"), undefined],
  [
    "http 500 is not a timeout",
    Object.assign(new Error("Internal server error"), { status: 500 }),
    undefined,
  ],
  ["rate limit beats timeout text", new Error("Rate limit exceeded, timeout: 30s"), "rate_limit"],
  ["undefined error", undefined, undefined],
] as const)("classifies chat errorKind for %s", (_name, error, expected) => {
  expect(resolveChatErrorKindFromError(error)).toBe(expected);
});
