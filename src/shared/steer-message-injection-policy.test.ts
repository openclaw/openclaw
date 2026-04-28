import { beforeEach, describe, expect, it } from "vitest";
import {
  INJECTED_STEER_RATE_LIMIT_MS,
  MAX_INJECTED_STEER_MESSAGE_CHARS,
  resetSteerMessageInjectionPolicyForTests,
  validateSteerMessageInjection,
} from "./steer-message-injection-policy.js";

describe("steer message injection policy", () => {
  beforeEach(() => {
    resetSteerMessageInjectionPolicyForTests();
  });

  it("rejects oversized steer injections", () => {
    expect(
      validateSteerMessageInjection({
        sessionId: "session-large",
        text: "x".repeat(MAX_INJECTED_STEER_MESSAGE_CHARS + 1),
      }),
    ).toEqual({ ok: false, reason: "message_too_large" });
  });

  it("rate limits repeated steer injections for the same session", () => {
    expect(
      validateSteerMessageInjection({
        sessionId: "session-rate",
        text: "first",
        nowMs: 10_000,
        enforceRateLimit: true,
      }),
    ).toEqual({ ok: true });
    expect(
      validateSteerMessageInjection({
        sessionId: "session-rate",
        text: "second",
        nowMs: 10_000 + INJECTED_STEER_RATE_LIMIT_MS - 1,
        enforceRateLimit: true,
      }),
    ).toEqual({ ok: false, reason: "rate_limited" });
    expect(
      validateSteerMessageInjection({
        sessionId: "session-rate",
        text: "third",
        nowMs: 10_000 + INJECTED_STEER_RATE_LIMIT_MS,
        enforceRateLimit: true,
      }),
    ).toEqual({ ok: true });
  });
});
