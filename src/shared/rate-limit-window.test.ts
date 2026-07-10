import { describe, expect, it } from "vitest";
import {
  isLongWindowRateLimitMessage,
  isShortWindowRateLimitMessage,
} from "./rate-limit-window.js";

describe("isShortWindowRateLimitMessage", () => {
  it.each([
    ["429 Provider returned error", true],
    ["429 insufficient_quota: You exceeded your current quota", false],
    ["429 usage limit reached for this billing period", false],
    ["Provider API error (429): Provider returned error", false],
    ["rate limit exceeded", false],
  ])("classifies %s", (message, expected) => {
    expect(isShortWindowRateLimitMessage(message)).toBe(expected);
  });
});

describe("isLongWindowRateLimitMessage", () => {
  it.each([
    "429 You exceeded your daily request limit. Please try again in 24 hours.",
    "rate limit reached for requests. Retry after 6h.",
    "You have hit your allotted requests per day.",
    "429 insufficient_quota: You exceeded your current quota",
    "429 usage limit reached for this billing period",
  ])("treats long-reset rate limits as long-window: %s", (message) => {
    expect(isLongWindowRateLimitMessage(message)).toBe(true);
  });

  it.each([
    "429 Provider returned error",
    "429 Too Many Requests",
    "429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric requests per minute",
  ])("treats short-window rate limits as not long-window: %s", (message) => {
    expect(isLongWindowRateLimitMessage(message)).toBe(false);
  });

  it.each([
    "socket hang up",
    "500 Internal Server Error",
    "overloaded_error: the model is overloaded",
    "",
  ])("returns false for non-rate-limit errors: %s", (message) => {
    expect(isLongWindowRateLimitMessage(message)).toBe(false);
  });
});
