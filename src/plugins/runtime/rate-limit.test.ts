import { describe, expect, test, beforeEach } from "vitest";
import { createPluginRuntime } from "./index.js";

describe("plugin runtime rate limiter", () => {
  let runtime: ReturnType<typeof createPluginRuntime>;

  beforeEach(() => {
    runtime = createPluginRuntime();
    // Reset any stale state between tests
    runtime.rateLimit.reset("test-key");
    runtime.rateLimit.reset("ip:1.2.3.4");
    runtime.rateLimit.reset("sender:https://agent.example.com");
  });

  test("allows requests under the limit", () => {
    for (let i = 0; i < 10; i++) {
      expect(runtime.rateLimit.check("test-key")).toBe(true);
    }
  });

  test("blocks requests over the limit", () => {
    for (let i = 0; i < 10; i++) {
      runtime.rateLimit.check("test-key");
    }
    expect(runtime.rateLimit.check("test-key")).toBe(false);
  });

  test("respects custom maxRequests", () => {
    const opts = { maxRequests: 3, windowMs: 60_000 };
    expect(runtime.rateLimit.check("test-key", opts)).toBe(true);
    expect(runtime.rateLimit.check("test-key", opts)).toBe(true);
    expect(runtime.rateLimit.check("test-key", opts)).toBe(true);
    expect(runtime.rateLimit.check("test-key", opts)).toBe(false);
  });

  test("tracks different keys independently", () => {
    const opts = { maxRequests: 2, windowMs: 60_000 };
    expect(runtime.rateLimit.check("ip:1.2.3.4", opts)).toBe(true);
    expect(runtime.rateLimit.check("ip:1.2.3.4", opts)).toBe(true);
    expect(runtime.rateLimit.check("ip:1.2.3.4", opts)).toBe(false);

    // Different key should still be allowed
    expect(runtime.rateLimit.check("sender:https://agent.example.com", opts)).toBe(true);
  });

  test("reset clears counters for a key", () => {
    const opts = { maxRequests: 2, windowMs: 60_000 };
    runtime.rateLimit.check("test-key", opts);
    runtime.rateLimit.check("test-key", opts);
    expect(runtime.rateLimit.check("test-key", opts)).toBe(false);

    runtime.rateLimit.reset("test-key");
    expect(runtime.rateLimit.check("test-key", opts)).toBe(true);
  });
});
