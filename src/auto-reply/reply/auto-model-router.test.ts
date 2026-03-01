import { afterEach, describe, expect, it } from "vitest";
import {
  AUTO_MODEL,
  _clearRouterState,
  resolveModelWithRouter,
  routeAutoModel,
} from "./auto-model-router.js";

afterEach(() => {
  _clearRouterState();
});

describe("auto-model-router", () => {
  describe("AUTO_MODEL", () => {
    it("equals 'auto'", () => {
      expect(AUTO_MODEL).toBe("auto");
    });
  });

  describe("routeAutoModel", () => {
    it("returns provider/model from config primary when configured", async () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
          },
        },
      } as Parameters<typeof routeAutoModel>[0]["cfg"];
      const result = await routeAutoModel({ cfg });
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-sonnet-4-6");
      expect(result.reason).toBe("default");
      expect(result.tag).toBe("expensive");
      expect(result.pass1TokenUsage).toEqual({
        input: 0,
        output: 0,
        estimated: true,
      });
    });

    it("returns default provider/model when config empty", async () => {
      const result = await routeAutoModel({ cfg: undefined });
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-opus-4-6");
      expect(result.reason).toBe("default");
      expect(result.tag).toBe("expensive");
    });

    it("falls back to last non-auto model when router choice unavailable in allowlist", async () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-4" },
            models: {
              "anthropic/claude-sonnet-4-6": {},
            },
            autoModelRouting: { router: {} },
          },
        },
      } as Parameters<typeof routeAutoModel>[0]["cfg"];
      const result = await routeAutoModel({
        cfg,
        lastNonAutoProvider: "anthropic",
        lastNonAutoModel: "claude-sonnet-4-6",
      });
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-sonnet-4-6");
      expect(result.reason).toBe("fallback-unavailable");
    });

    it("uses router choice when available in allowlist", async () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: {
              "anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      } as Parameters<typeof routeAutoModel>[0]["cfg"];
      const result = await routeAutoModel({
        cfg,
        lastNonAutoProvider: "anthropic",
        lastNonAutoModel: "claude-opus-4-6",
      });
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-sonnet-4-6");
      expect(result.reason).toBe("default");
    });
  });

  describe("resolveModelWithRouter", () => {
    it("returns routed when model is AUTO_MODEL", async () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-4o-mini" },
          },
        },
      } as Parameters<typeof resolveModelWithRouter>[0]["cfg"];
      const resolved = await resolveModelWithRouter({
        cfg,
        provider: "anthropic",
        model: AUTO_MODEL,
      });
      expect(resolved.routed).toBe(true);
      if (resolved.routed) {
        expect(resolved.result.provider).toBe("openai");
        expect(resolved.result.model).toBe("gpt-4o-mini");
      }
    });

    it("returns not routed when model is not AUTO_MODEL", async () => {
      const resolved = await resolveModelWithRouter({
        cfg: undefined,
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      expect(resolved.routed).toBe(false);
      if (!resolved.routed) {
        expect(resolved.provider).toBe("anthropic");
        expect(resolved.model).toBe("claude-opus-4-6");
      }
    });

    it("treats 'auto' case-insensitively", async () => {
      const resolved = await resolveModelWithRouter({
        cfg: undefined,
        provider: "x",
        model: "AUTO",
      });
      expect(resolved.routed).toBe(true);
    });
  });

  describe("dedupe", () => {
    it("dedupes in-flight requests with same key", async () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
          },
        },
      } as Parameters<typeof routeAutoModel>[0]["cfg"];
      const [a, b] = await Promise.all([
        routeAutoModel({
          cfg,
          sessionKey: "s1",
          agentId: "a1",
          promptHash: "h1",
        }),
        routeAutoModel({
          cfg,
          sessionKey: "s1",
          agentId: "a1",
          promptHash: "h1",
        }),
      ]);
      expect(a).toEqual(b);
    });

    it("returns different results for different keys", async () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
          },
        },
      } as Parameters<typeof routeAutoModel>[0]["cfg"];
      const [a, b] = await Promise.all([
        routeAutoModel({ cfg, sessionKey: "s1", promptHash: "h1" }),
        routeAutoModel({ cfg, sessionKey: "s2", promptHash: "h2" }),
      ]);
      expect(a).toEqual(b);
    });
  });

  describe("cache", () => {
    it("returns cached result within TTL", async () => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
            autoModelRouting: {
              router: { cacheTtlMs: 60_000, dedupeTtlMs: 100 },
            },
          },
        },
      } as Parameters<typeof routeAutoModel>[0]["cfg"];
      const result1 = await routeAutoModel({
        cfg,
        sessionKey: "s1",
        agentId: "a1",
      });
      const result2 = await routeAutoModel({
        cfg,
        sessionKey: "s1",
        agentId: "a1",
      });
      expect(result1).toEqual(result2);
    });
  });
});
