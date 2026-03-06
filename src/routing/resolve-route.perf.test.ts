import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveAgentRoute } from "./resolve-route.js";

/**
 * Performance regression test for large binding configurations.
 * Ensures resolveAgentRoute remains fast with 80k+ bindings. (#36915)
 */
describe("resolveAgentRoute performance (#36915)", () => {
  const BINDING_COUNT = 80_000;
  const TARGET_CHANNEL = "dingtalk";
  const ACCOUNT_ID = "default";

  function buildLargeConfig(): OpenClawConfig {
    const bindings = [];
    for (let i = 0; i < BINDING_COUNT; i++) {
      bindings.push({
        agentId: `agent-${i}`,
        match: {
          channel: TARGET_CHANNEL,
          peer: { kind: "direct" as const, id: `user-${i}` },
        },
      });
    }
    return { bindings } as unknown as OpenClawConfig;
  }

  it(`resolves route in <500ms with ${BINDING_COUNT} bindings (cold)`, () => {
    const cfg = buildLargeConfig();

    const start = performance.now();
    const route = resolveAgentRoute({
      cfg,
      channel: TARGET_CHANNEL,
      accountId: ACCOUNT_ID,
      peer: { kind: "direct", id: "user-42" },
    });
    const elapsed = performance.now() - start;

    expect(route.agentId).toBe("agent-42");
    expect(elapsed).toBeLessThan(500);
  });

  it(`resolves route in <10ms with ${BINDING_COUNT} bindings (warm cache)`, () => {
    const cfg = buildLargeConfig();

    // Warm the cache
    resolveAgentRoute({
      cfg,
      channel: TARGET_CHANNEL,
      accountId: ACCOUNT_ID,
      peer: { kind: "direct", id: "user-0" },
    });

    const start = performance.now();
    const route = resolveAgentRoute({
      cfg,
      channel: TARGET_CHANNEL,
      accountId: ACCOUNT_ID,
      peer: { kind: "direct", id: "user-99" },
    });
    const elapsed = performance.now() - start;

    expect(route.agentId).toBe("agent-99");
    expect(elapsed).toBeLessThan(10);
  });

  it("routes to correct agent among many bindings", () => {
    const cfg = buildLargeConfig();

    for (const idx of [0, 1000, 50000, 79999]) {
      const route = resolveAgentRoute({
        cfg,
        channel: TARGET_CHANNEL,
        accountId: ACCOUNT_ID,
        peer: { kind: "direct", id: `user-${idx}` },
      });
      expect(route.agentId).toBe(`agent-${idx}`);
    }
  });
});
