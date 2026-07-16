// Verifies config IO warning and pending-secret caches are bounded across process lifetime.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("config IO state caches", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("loggedInvalidConfigs dedupe cache", () => {
    it("caps at MAX_LOGGED_INVALID_CONFIGS and re-warns evicted paths", async () => {
      const { loggedInvalidConfigs, MAX_LOGGED_INVALID_CONFIGS } = await import("./io.state.js");
      const { throwInvalidConfig } = await import("./io.invalid-config.js");
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      for (let i = 0; i < MAX_LOGGED_INVALID_CONFIGS; i++) {
        expect(() =>
          throwInvalidConfig({
            configPath: `/config-${i}.json`,
            issues: [{ path: "root", message: "invalid" }],
            logger: console,
            loggedConfigPaths: loggedInvalidConfigs,
          }),
        ).toThrow();
      }
      expect(errorSpy).toHaveBeenCalledTimes(MAX_LOGGED_INVALID_CONFIGS);
      expect(loggedInvalidConfigs.size()).toBe(MAX_LOGGED_INVALID_CONFIGS);

      // Refresh the first entry; it stays in the cache.
      expect(() =>
        throwInvalidConfig({
          configPath: "/config-0.json",
          issues: [{ path: "root", message: "invalid" }],
          logger: console,
          loggedConfigPaths: loggedInvalidConfigs,
        }),
      ).toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(MAX_LOGGED_INVALID_CONFIGS);

      // Overflow evicts the oldest entry (now config-1 because config-0 was refreshed).
      expect(() =>
        throwInvalidConfig({
          configPath: "/overflow.json",
          issues: [{ path: "root", message: "invalid" }],
          logger: console,
          loggedConfigPaths: loggedInvalidConfigs,
        }),
      ).toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(MAX_LOGGED_INVALID_CONFIGS + 1);

      // The evicted entry re-warns.
      expect(() =>
        throwInvalidConfig({
          configPath: "/config-1.json",
          issues: [{ path: "root", message: "invalid" }],
          logger: console,
          loggedConfigPaths: loggedInvalidConfigs,
        }),
      ).toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(MAX_LOGGED_INVALID_CONFIGS + 2);
    });
  });

  describe("warnedFutureTouchedVersions dedupe cache", () => {
    it("caps at MAX_WARNED_FUTURE_TOUCHED_VERSIONS and re-warns evicted versions", async () => {
      const { warnedFutureTouchedVersions, MAX_WARNED_FUTURE_TOUCHED_VERSIONS } =
        await import("./io.state.js");
      const { warnIfConfigFromFuture } = await import("./io.warnings.js");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      for (let i = 0; i < MAX_WARNED_FUTURE_TOUCHED_VERSIONS; i++) {
        warnIfConfigFromFuture(
          { meta: { lastTouchedVersion: `3000.1.${i}` } } as Parameters<
            typeof warnIfConfigFromFuture
          >[0],
          console,
        );
      }
      expect(warnSpy).toHaveBeenCalledTimes(MAX_WARNED_FUTURE_TOUCHED_VERSIONS);
      expect(warnedFutureTouchedVersions.size()).toBe(MAX_WARNED_FUTURE_TOUCHED_VERSIONS);

      // Refresh the first entry.
      warnIfConfigFromFuture(
        { meta: { lastTouchedVersion: "3000.1.0" } } as Parameters<
          typeof warnIfConfigFromFuture
        >[0],
        console,
      );
      expect(warnSpy).toHaveBeenCalledTimes(MAX_WARNED_FUTURE_TOUCHED_VERSIONS);

      // Overflow evicts the oldest entry.
      warnIfConfigFromFuture(
        { meta: { lastTouchedVersion: "3000.1.9999" } } as Parameters<
          typeof warnIfConfigFromFuture
        >[0],
        console,
      );
      expect(warnSpy).toHaveBeenCalledTimes(MAX_WARNED_FUTURE_TOUCHED_VERSIONS + 1);

      // The evicted entry re-warns.
      warnIfConfigFromFuture(
        { meta: { lastTouchedVersion: "3000.1.1" } } as Parameters<
          typeof warnIfConfigFromFuture
        >[0],
        console,
      );
      expect(warnSpy).toHaveBeenCalledTimes(MAX_WARNED_FUTURE_TOUCHED_VERSIONS + 2);
    });
  });

  describe("loggedConfigWarningFingerprints map", () => {
    it("prunes to MAX_LOGGED_CONFIG_WARNING_FINGERPRINTS preserving newest entries", async () => {
      const { loggedConfigWarningFingerprints, MAX_LOGGED_CONFIG_WARNING_FINGERPRINTS } =
        await import("./io.state.js");
      const { logConfigWarningsOnce } = await import("./io.warnings.js");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      for (let i = 0; i < MAX_LOGGED_CONFIG_WARNING_FINGERPRINTS; i++) {
        logConfigWarningsOnce({
          configPath: `/config-${i}.json`,
          warnings: [{ path: "root", message: `warning-${i}` }],
          logger: console,
        });
      }
      expect(loggedConfigWarningFingerprints.size).toBe(MAX_LOGGED_CONFIG_WARNING_FINGERPRINTS);
      expect(loggedConfigWarningFingerprints.has("/config-0.json")).toBe(true);

      // Add an overflow entry; the oldest insertion-order key is evicted.
      logConfigWarningsOnce({
        configPath: "/overflow.json",
        warnings: [{ path: "root", message: "overflow" }],
        logger: console,
      });
      expect(loggedConfigWarningFingerprints.size).toBe(MAX_LOGGED_CONFIG_WARNING_FINGERPRINTS);
      expect(loggedConfigWarningFingerprints.has("/config-0.json")).toBe(false);
      expect(loggedConfigWarningFingerprints.has("/overflow.json")).toBe(true);

      expect(warnSpy).toHaveBeenCalledTimes(MAX_LOGGED_CONFIG_WARNING_FINGERPRINTS + 1);
    });
  });

  describe("autoOwnerDisplaySecretByPath map", () => {
    it("prunes to MAX_AUTO_OWNER_DISPLAY_SECRET_BY_PATH preserving newest entries", async () => {
      const { autoOwnerDisplaySecretByPath, MAX_AUTO_OWNER_DISPLAY_SECRET_BY_PATH } =
        await import("./io.state.js");
      const { retainGeneratedOwnerDisplaySecret } = await import("./io.owner-display-secret.js");

      const config = {} as Parameters<typeof retainGeneratedOwnerDisplaySecret>[0]["config"];
      for (let i = 0; i < MAX_AUTO_OWNER_DISPLAY_SECRET_BY_PATH; i++) {
        retainGeneratedOwnerDisplaySecret({
          config,
          configPath: `/config-${i}.json`,
          generatedSecret: `secret-${i}`,
          state: { pendingByPath: autoOwnerDisplaySecretByPath },
        });
      }
      expect(autoOwnerDisplaySecretByPath.size).toBe(MAX_AUTO_OWNER_DISPLAY_SECRET_BY_PATH);
      expect(autoOwnerDisplaySecretByPath.has("/config-0.json")).toBe(true);

      // Add an overflow entry; the oldest insertion-order key is evicted.
      retainGeneratedOwnerDisplaySecret({
        config,
        configPath: "/overflow.json",
        generatedSecret: "overflow-secret",
        state: { pendingByPath: autoOwnerDisplaySecretByPath },
      });
      expect(autoOwnerDisplaySecretByPath.size).toBe(MAX_AUTO_OWNER_DISPLAY_SECRET_BY_PATH);
      expect(autoOwnerDisplaySecretByPath.has("/config-0.json")).toBe(false);
      expect(autoOwnerDisplaySecretByPath.has("/overflow.json")).toBe(true);
    });
  });
});
