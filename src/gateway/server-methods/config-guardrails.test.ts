import { describe, expect, it } from "vitest";
import { checkConfigGuardrails, CRITICAL_CONFIG_KEYS, MIN_SIZE_RATIO } from "./config.js";

describe("checkConfigGuardrails", () => {
  describe("force flag", () => {
    it("bypasses all checks when force is true", () => {
      const existing = { auth: { token: "secret" }, channels: {}, plugins: {} };
      const result = checkConfigGuardrails(existing, {}, { force: true });
      expect(result.ok).toBe(true);
    });
  });

  describe("null/missing existing config", () => {
    it("allows any config when existing is null", () => {
      const result = checkConfigGuardrails(null, { agents: {} }, { force: false });
      expect(result.ok).toBe(true);
    });

    it("allows any config when existing is not an object", () => {
      const result = checkConfigGuardrails(
        "not-an-object" as unknown as Record<string, unknown>,
        { agents: {} },
        { force: false },
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("size ratio check", () => {
    it("rejects config significantly smaller than existing", () => {
      const existing = {
        auth: { token: "very-long-token-string-here" },
        channels: { list: [{ id: "ch1" }, { id: "ch2" }] },
        plugins: { enabled: ["plugin1", "plugin2", "plugin3"] },
        agents: { list: [{ id: "main", workspace: "~/openclaw" }] },
        server: { port: 3000, host: "localhost" },
      };
      const tiny = { agents: {} };

      const result = checkConfigGuardrails(existing, tiny, { force: false });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("size of current config");
        expect(result.error).toContain("force: true");
        expect(result.details?.sizeRatio).toBeDefined();
        expect(result.details!.sizeRatio!).toBeLessThan(MIN_SIZE_RATIO);
      }
    });

    it("allows config of similar size", () => {
      const existing = { agents: { list: [{ id: "main" }] } };
      const similar = { agents: { list: [{ id: "test" }] } };

      const result = checkConfigGuardrails(existing, similar, { force: false });
      expect(result.ok).toBe(true);
    });
  });

  describe("critical key removal check", () => {
    it.each(CRITICAL_CONFIG_KEYS)("rejects removal of critical key: %s", (key) => {
      const existing = { [key]: { some: "value" }, other: "data" };
      const withoutKey = { other: "data", extra: "padding-to-pass-size-check" };

      const result = checkConfigGuardrails(existing, withoutKey, { force: false });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Critical config sections");
        expect(result.error).toContain(key);
        expect(result.details?.removedKeys).toContain(key);
      }
    });

    it("allows removal of non-critical keys", () => {
      const existing = { agents: {}, customKey: "value" };
      const withoutCustom = { agents: {}, other: "value" };

      const result = checkConfigGuardrails(existing, withoutCustom, { force: false });
      expect(result.ok).toBe(true);
    });

    it("reports multiple removed critical keys", () => {
      const existing = { auth: {}, channels: {}, plugins: {}, other: "x".repeat(100) };
      const minimal = { other: "x".repeat(100) };

      const result = checkConfigGuardrails(existing, minimal, { force: false });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.details?.removedKeys).toContain("auth");
        expect(result.details?.removedKeys).toContain("channels");
        expect(result.details?.removedKeys).toContain("plugins");
      }
    });
  });

  describe("combined checks", () => {
    it("allows valid config changes", () => {
      const existing = {
        agents: { list: [{ id: "main" }] },
        channels: { list: [] },
        auth: { enabled: false },
      };
      const updated = {
        agents: { list: [{ id: "main" }, { id: "second" }] },
        channels: { list: [{ id: "new-channel" }] },
        auth: { enabled: true, token: "new-token" },
      };

      const result = checkConfigGuardrails(existing, updated, { force: false });
      expect(result.ok).toBe(true);
    });

    it("size check triggers before key check for very small configs", () => {
      const existing = {
        auth: { token: "x".repeat(100) },
        channels: { list: Array(10).fill({ id: "ch" }) },
        plugins: { enabled: Array(5).fill("plugin") },
      };
      const tiny = { newKey: "x" };

      const result = checkConfigGuardrails(existing, tiny, { force: false });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("size");
      }
    });
  });
});
