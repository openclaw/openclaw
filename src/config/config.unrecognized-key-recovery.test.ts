import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";
import {
  applyUnrecognizedKeyRecovery,
  tryRecoverUnrecognizedKeys,
  validateConfigObject,
  validateConfigObjectWithPlugins,
} from "./validation.js";

describe("unrecognized-key config recovery (#65721)", () => {
  describe("tryRecoverUnrecognizedKeys", () => {
    it("recovers config with unrecognized key inside env.shellEnv (issue repro)", () => {
      const raw = {
        env: {
          shellEnv: {
            enabled: true,
            vars: { PATH: "/usr/bin" },
          },
        },
      };
      const result = tryRecoverUnrecognizedKeys(raw);
      expect(result.recovered).toBe(true);
      if (result.recovered) {
        expect(result.strippedPathsDisplay).toEqual(["env.shellEnv.vars"]);
        expect(result.config.env?.shellEnv?.enabled).toBe(true);
      }
    });

    it("does not recover config with non-unrecognized-key errors", () => {
      const raw = {
        gateway: {
          port: "not-a-number",
        },
      };
      const result = tryRecoverUnrecognizedKeys(raw);
      expect(result.recovered).toBe(false);
    });
  });

  describe("applyUnrecognizedKeyRecovery", () => {
    it("heals within allowed top-level keys and logs at error level", () => {
      const raw = {
        env: {
          shellEnv: {
            enabled: true,
            vars: { PATH: "/usr/bin" },
          },
        },
      };
      const logger = { error: vi.fn(), warn: vi.fn() };
      const result = applyUnrecognizedKeyRecovery(
        raw,
        (cleaned) => validateConfigObjectWithPlugins(cleaned),
        logger,
        "/home/user/.openclaw/openclaw.json",
        { allowedTopLevelKeys: ["agents", "meta", "env"] },
      );
      expect(result.healed).toBe(true);
      expect(logger.error).toHaveBeenCalledTimes(1);
      const errorMsg = logger.error.mock.calls[0]?.[0] as string;
      expect(errorMsg).toContain("Config auto-healed");
      expect(errorMsg).toContain("env.shellEnv.vars");
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("blocks healing when stripped keys fall outside allowed top-level keys", () => {
      const raw = {
        gateway: {
          mode: "local",
          bogus: "should-be-stripped",
        },
      };
      const logger = { error: vi.fn(), warn: vi.fn() };
      const result = applyUnrecognizedKeyRecovery(
        raw,
        (cleaned) => validateConfigObjectWithPlugins(cleaned),
        logger,
        "/path/to/config.json",
        { allowedTopLevelKeys: ["env"] },
      );
      expect(result.healed).toBe(false);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const warnMsg = logger.warn.mock.calls[0]?.[0] as string;
      expect(warnMsg).toContain("auto-heal skipped");
      expect(warnMsg).toContain("fail-closed");
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("skips recovery when rawFileSize exceeds limit", () => {
      const raw = {
        env: {
          shellEnv: {
            enabled: true,
            vars: { PATH: "/usr/bin" },
          },
        },
      };
      const logger = { error: vi.fn(), warn: vi.fn() };
      const result = applyUnrecognizedKeyRecovery(
        raw,
        (cleaned) => validateConfigObjectWithPlugins(cleaned),
        logger,
        "/path/to/config.json",
        { rawFileSize: 3 * 1024 * 1024 },
      );
      expect(result.healed).toBe(false);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const warnMsg = logger.warn.mock.calls[0]?.[0] as string;
      expect(warnMsg).toContain("exceeds");
    });

    it("ignores allowedTopLevelKeys entries containing dots", () => {
      // "env.shellEnv" contains a dot and should be silently ignored,
      // leaving no valid allowed keys → healing should be blocked.
      const raw = {
        env: {
          shellEnv: {
            enabled: true,
            vars: { PATH: "/usr/bin" },
          },
        },
      };
      const logger = { error: vi.fn(), warn: vi.fn() };
      const result = applyUnrecognizedKeyRecovery(
        raw,
        (cleaned) => validateConfigObjectWithPlugins(cleaned),
        logger,
        "/path/to/config.json",
        { allowedTopLevelKeys: ["env.shellEnv"] },
      );
      expect(result.healed).toBe(false);
    });
  });

  describe("validateConfigObject still rejects unrecognized keys", () => {
    it("rejects env.shellEnv.vars as invalid", () => {
      const result = validateConfigObject({
        env: {
          shellEnv: {
            enabled: true,
            vars: { PATH: "/usr/bin" },
          },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((i) => i.message.includes("Unrecognized key"))).toBe(true);
      }
    });
  });

  describe("loadConfig recovers from unrecognized keys", () => {
    it("loads successfully when env.shellEnv contains unrecognized keys", async () => {
      await withTempHomeConfig(
        {
          env: {
            shellEnv: {
              enabled: false,
              vars: { PATH: "/usr/bin" },
            },
          },
        },
        async () => {
          const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
          try {
            const config = loadConfig();
            expect(config).toBeDefined();
            const errorMessages = errorSpy.mock.calls.flat().join(" ");
            expect(errorMessages).toContain("Config auto-healed");
            expect(errorMessages).toContain("env.shellEnv.vars");
          } finally {
            errorSpy.mockRestore();
          }
        },
      );
    });

    it("still throws for non-unrecognized-key errors", async () => {
      await withTempHomeConfig(
        {
          gateway: {
            port: "not-a-number",
          },
        },
        async () => {
          const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
          try {
            expect(() => loadConfig()).toThrow();
          } finally {
            errorSpy.mockRestore();
          }
        },
      );
    });
  });
});
