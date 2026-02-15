import { afterEach, describe, expect, it, vi } from "vitest";
import { checkFallbackNotification } from "./fallback-notify.js";

describe("checkFallbackNotification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined when no attempts (primary succeeded)", () => {
    const result = checkFallbackNotification({
      sessionKey: "test-session-1",
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "openai",
      usedModel: "gpt-4.1-mini",
      attempts: [],
    });
    expect(result).toBeUndefined();
  });

  it("returns a notification when fallback model is used", () => {
    const result = checkFallbackNotification({
      sessionKey: "test-session-2",
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [
        {
          provider: "openai",
          model: "gpt-4.1-mini",
          error: "rate limited",
          reason: "rate_limit",
        },
      ],
    });
    expect(result).toBeDefined();
    expect(result).toContain("anthropic/claude-haiku-3-5");
    expect(result).toContain("openai/gpt-4.1-mini");
    expect(result).toContain("rate_limit");
  });

  it("suppresses duplicate notifications for the same fallback", () => {
    const sessionKey = "test-session-3";
    const params = {
      sessionKey,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [
        {
          provider: "openai",
          model: "gpt-4.1-mini",
          error: "rate limited",
          reason: "rate_limit" as const,
        },
      ],
    };

    // First call should notify
    const first = checkFallbackNotification(params);
    expect(first).toBeDefined();

    // Second call with same fallback should be suppressed
    const second = checkFallbackNotification(params);
    expect(second).toBeUndefined();
  });

  it("clears tracker when primary succeeds again", () => {
    const sessionKey = "test-session-4";

    // Fallback used — should notify
    const first = checkFallbackNotification({
      sessionKey,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "rate limited" }],
    });
    expect(first).toBeDefined();

    // Primary recovers — clears tracker
    checkFallbackNotification({
      sessionKey,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "openai",
      usedModel: "gpt-4.1-mini",
      attempts: [],
    });

    // Fallback again — should notify again (new failover event)
    const third = checkFallbackNotification({
      sessionKey,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "rate limited" }],
    });
    expect(third).toBeDefined();
  });

  it("notifies again when fallback model changes", () => {
    const sessionKey = "test-session-5";

    // First fallback
    const first = checkFallbackNotification({
      sessionKey,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "rate limited" }],
    });
    expect(first).toBeDefined();
    expect(first).toContain("claude-haiku-3-5");

    // Different fallback model — should notify again
    const second = checkFallbackNotification({
      sessionKey,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "google",
      usedModel: "gemini-2.5-flash",
      attempts: [
        { provider: "openai", model: "gpt-4.1-mini", error: "rate limited" },
        { provider: "anthropic", model: "claude-haiku-3-5", error: "also rate limited" },
      ],
    });
    expect(second).toBeDefined();
    expect(second).toContain("gemini-2.5-flash");
  });

  it("returns undefined when used model matches original despite attempts", () => {
    const result = checkFallbackNotification({
      sessionKey: "test-session-6",
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "openai",
      usedModel: "gpt-4.1-mini",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "transient error" }],
    });
    expect(result).toBeUndefined();
  });

  it("works without a session key", () => {
    const result = checkFallbackNotification({
      sessionKey: undefined,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "rate limited" }],
    });
    expect(result).toBeDefined();
  });

  it("includes reason from the primary attempt when available", () => {
    const result = checkFallbackNotification({
      sessionKey: "test-session-7",
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [
        {
          provider: "openai",
          model: "gpt-4.1-mini",
          error: "billing error",
          reason: "billing",
        },
      ],
    });
    expect(result).toContain("billing");
  });

  it("omits reason when not available on primary attempt", () => {
    const result = checkFallbackNotification({
      sessionKey: "test-session-8",
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "unknown error" }],
    });
    expect(result).toBeDefined();
    expect(result).not.toContain("(undefined)");
  });

  it("evicts oldest entries when exceeding max tracked sessions", () => {
    // Fill up the tracker beyond the 1000-entry cap.
    // We add 1002 unique sessions, then verify the first two were evicted
    // by checking that a new call with those keys produces a notification
    // (meaning they were forgotten).
    for (let i = 0; i < 1002; i++) {
      checkFallbackNotification({
        sessionKey: `evict-cap-${i}`,
        originalProvider: "openai",
        originalModel: "gpt-4.1-mini",
        usedProvider: "anthropic",
        usedModel: "claude-haiku-3-5",
        attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "rate limited" }],
      });
    }

    // Session 0 and 1 should have been evicted — calling again should notify
    const evicted = checkFallbackNotification({
      sessionKey: "evict-cap-0",
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "rate limited" }],
    });
    expect(evicted).toBeDefined();

    // Session 1001 should still be tracked — calling again should suppress
    const retained = checkFallbackNotification({
      sessionKey: "evict-cap-1001",
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "rate limited" }],
    });
    expect(retained).toBeUndefined();
  });

  it("evicts stale entries based on TTL", () => {
    const sessionKey = "test-ttl-session";

    // Record a fallback notification
    const first = checkFallbackNotification({
      sessionKey,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "rate limited" }],
    });
    expect(first).toBeDefined();

    // Same call is suppressed (entry exists)
    const suppressed = checkFallbackNotification({
      sessionKey,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "rate limited" }],
    });
    expect(suppressed).toBeUndefined();

    // Advance time by > 1 hour so the entry expires
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60 * 1000);

    // Entry should have been evicted — notification fires again
    const afterTtl = checkFallbackNotification({
      sessionKey,
      originalProvider: "openai",
      originalModel: "gpt-4.1-mini",
      usedProvider: "anthropic",
      usedModel: "claude-haiku-3-5",
      attempts: [{ provider: "openai", model: "gpt-4.1-mini", error: "rate limited" }],
    });
    expect(afterTtl).toBeDefined();
  });
});
