import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IS_WINDOWS } from "./config.backup-rotation.test-helpers.js";
import {
  maybeRecoverSuspiciousConfigRead,
  maybeRecoverSuspiciousConfigReadSync,
  maybeRecoverFromSchemaInvalidConfigSync,
  type ObserveRecoveryDeps,
} from "./io.observe-recovery.js";

describe("config observe recovery", () => {
  let fixtureRoot = "";
  let homeCaseId = 0;

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = path.join(fixtureRoot, `case-${homeCaseId++}`);
    await fsp.mkdir(home, { recursive: true });
    return await fn(home);
  }

  beforeAll(async () => {
    fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-config-observe-recovery-"));
  });

  afterAll(async () => {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function seedConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  }

  function makeDeps(
    home: string,
    warn = vi.fn(),
  ): {
    deps: ObserveRecoveryDeps;
    configPath: string;
    auditPath: string;
    warn: ReturnType<typeof vi.fn>;
  } {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    return {
      deps: {
        fs,
        json5: JSON5,
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn },
      },
      configPath,
      auditPath: path.join(home, ".openclaw", "logs", "config-audit.jsonl"),
      warn,
    };
  }

  it("auto-restores suspicious update-channel-only roots from backup", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath, warn } = makeDeps(home);
      await seedConfig(configPath, {
        update: { channel: "beta" },
        browser: { enabled: true },
        gateway: { mode: "local", auth: { mode: "token", token: "secret-token" } },
        channels: { discord: { enabled: true, dmPolicy: "pairing" } },
      });
      await fsp.copyFile(configPath, `${configPath}.bak`);

      const clobberedRaw = `${JSON.stringify({ update: { channel: "beta" } }, null, 2)}\n`;
      await fsp.writeFile(configPath, clobberedRaw, "utf-8");

      const recovered = await maybeRecoverSuspiciousConfigRead({
        deps,
        configPath,
        raw: clobberedRaw,
        parsed: { update: { channel: "beta" } },
      });

      expect((recovered.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
      await expect(fsp.readFile(configPath, "utf-8")).resolves.not.toBe(clobberedRaw);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Config auto-restored from backup:"),
      );

      const lines = (await fsp.readFile(auditPath, "utf-8")).trim().split("\n").filter(Boolean);
      const observe = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .findLast((line) => line.event === "config.observe");
      expect(observe?.restoredFromBackup).toBe(true);
      expect(observe?.suspicious).toEqual(
        expect.arrayContaining(["gateway-mode-missing-vs-last-good", "update-channel-only-root"]),
      );
    });
  });

  it("dedupes repeated suspicious hashes", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath } = makeDeps(home);
      await seedConfig(configPath, {
        update: { channel: "beta" },
        gateway: { mode: "local" },
        channels: { telegram: { enabled: true, dmPolicy: "pairing", groupPolicy: "allowlist" } },
      });
      await fsp.copyFile(configPath, `${configPath}.bak`);

      const clobberedRaw = `${JSON.stringify({ update: { channel: "beta" } }, null, 2)}\n`;
      await fsp.writeFile(configPath, clobberedRaw, "utf-8");

      await maybeRecoverSuspiciousConfigRead({
        deps,
        configPath,
        raw: clobberedRaw,
        parsed: { update: { channel: "beta" } },
      });
      await maybeRecoverSuspiciousConfigRead({
        deps,
        configPath,
        raw: clobberedRaw,
        parsed: { update: { channel: "beta" } },
      });

      const lines = (await fsp.readFile(auditPath, "utf-8")).trim().split("\n").filter(Boolean);
      const observeEvents = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === "config.observe");
      expect(observeEvents).toHaveLength(1);
    });
  });

  it("sync recovery uses backup baseline when health state is absent", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath } = makeDeps(home);
      await seedConfig(configPath, {
        update: { channel: "beta" },
        gateway: { mode: "local" },
        channels: { telegram: { enabled: true, dmPolicy: "pairing", groupPolicy: "allowlist" } },
      });
      await fsp.copyFile(configPath, `${configPath}.bak`);

      const clobberedRaw = `${JSON.stringify({ update: { channel: "beta" } }, null, 2)}\n`;
      await fsp.writeFile(configPath, clobberedRaw, "utf-8");

      const recovered = maybeRecoverSuspiciousConfigReadSync({
        deps,
        configPath,
        raw: clobberedRaw,
        parsed: { update: { channel: "beta" } },
      });

      expect((recovered.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
      const lines = (await fsp.readFile(auditPath, "utf-8")).trim().split("\n").filter(Boolean);
      const observe = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .findLast((line) => line.event === "config.observe");
      expect(observe?.backupHash).toBeTypeOf("string");
      expect(observe?.lastKnownGoodIno ?? null).toBeNull();
    });
  });

  describe("maybeRecoverFromSchemaInvalidConfigSync", () => {
    // A validate stub that accepts any object with a `gateway.mode` field.
    function validateHasGatewayMode(parsed: unknown): boolean {
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).gateway === "object" &&
        (parsed as Record<string, unknown>).gateway !== null &&
        typeof ((parsed as Record<string, { mode?: unknown }>).gateway as { mode?: unknown })
          .mode === "string"
      );
    }

    it("restores the primary .bak when it passes schema validation", async () => {
      await withSuiteHome(async (home) => {
        const { deps, configPath, warn } = makeDeps(home);

        // Seed a valid backup
        await seedConfig(`${configPath}.bak`, { gateway: { mode: "local" } });

        // Write a schema-invalid primary config
        await seedConfig(configPath, { env: { shellEnv: { vars: { HOME: "/bad" } } } });

        const result = maybeRecoverFromSchemaInvalidConfigSync({
          deps,
          configPath,
          validate: validateHasGatewayMode,
        });

        expect(result).toBe(true);
        // Primary config should now match the backup
        const restoredRaw = await fsp.readFile(configPath, "utf-8");
        const restoredParsed = JSON.parse(restoredRaw) as Record<string, unknown>;
        expect((restoredParsed.gateway as { mode?: string } | undefined)?.mode).toBe("local");
        // Warning logged
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("schema-invalid"));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(".bak"));
        // Clobbered snapshot archived
        const dir = path.dirname(configPath);
        const entries = await fsp.readdir(dir);
        expect(entries.some((e) => e.includes(".clobbered."))).toBe(true);
      });
    });

    it("falls through to .bak.1 when primary .bak is also schema-invalid", async () => {
      await withSuiteHome(async (home) => {
        const { deps, configPath, warn } = makeDeps(home);

        // Primary .bak is also invalid; .bak.1 is valid
        await seedConfig(`${configPath}.bak`, { env: { shellEnv: { vars: { HOME: "/bad" } } } });
        await seedConfig(`${configPath}.bak.1`, { gateway: { mode: "local" } });
        await seedConfig(configPath, { env: { shellEnv: { vars: { HOME: "/bad" } } } });

        const result = maybeRecoverFromSchemaInvalidConfigSync({
          deps,
          configPath,
          validate: validateHasGatewayMode,
        });

        expect(result).toBe(true);
        const restoredRaw = await fsp.readFile(configPath, "utf-8");
        const restoredParsed = JSON.parse(restoredRaw) as Record<string, unknown>;
        expect((restoredParsed.gateway as { mode?: string } | undefined)?.mode).toBe("local");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(".bak.1"));
      });
    });

    it("returns false when all backups fail schema validation", async () => {
      await withSuiteHome(async (home) => {
        const { deps, configPath, warn } = makeDeps(home);

        // All backups are also invalid
        await seedConfig(`${configPath}.bak`, { env: { shellEnv: { vars: { HOME: "/bad" } } } });
        await seedConfig(configPath, { env: { shellEnv: { vars: { HOME: "/bad" } } } });

        const result = maybeRecoverFromSchemaInvalidConfigSync({
          deps,
          configPath,
          validate: validateHasGatewayMode,
        });

        expect(result).toBe(false);
        // Config should be unchanged
        const rawAfter = await fsp.readFile(configPath, "utf-8");
        expect(JSON.parse(rawAfter)).toEqual({
          env: { shellEnv: { vars: { HOME: "/bad" } } },
        });
        expect(warn).not.toHaveBeenCalled();
      });
    });

    it("returns false when no backup files exist", async () => {
      await withSuiteHome(async (home) => {
        const { deps, configPath, warn } = makeDeps(home);

        await seedConfig(configPath, { env: { shellEnv: { vars: { HOME: "/bad" } } } });

        const result = maybeRecoverFromSchemaInvalidConfigSync({
          deps,
          configPath,
          validate: validateHasGatewayMode,
        });

        expect(result).toBe(false);
        expect(warn).not.toHaveBeenCalled();
      });
    });

    it("creates the primary config file when it was missing and a valid backup exists", async () => {
      await withSuiteHome(async (home) => {
        const { deps, configPath, warn } = makeDeps(home);

        await fsp.mkdir(path.dirname(configPath), { recursive: true });
        await seedConfig(`${configPath}.bak`, { gateway: { mode: "local" } });
        // No primary config file — copyFile to a new path should succeed

        const result = maybeRecoverFromSchemaInvalidConfigSync({
          deps,
          configPath,
          validate: validateHasGatewayMode,
        });

        expect(result).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("schema-invalid"));
        const restoredRaw = await fsp.readFile(configPath, "utf-8");
        const restoredParsed = JSON.parse(restoredRaw) as Record<string, unknown>;
        expect((restoredParsed.gateway as { mode?: string } | undefined)?.mode).toBe("local");
      });
    });

    it.skipIf(IS_WINDOWS)(
      "skips a backup candidate that is a symlink (CWE-59 / TOCTOU guard)",
      async () => {
        await withSuiteHome(async (home) => {
          const { deps, configPath, warn } = makeDeps(home);

          await fsp.mkdir(path.dirname(configPath), { recursive: true });

          // Plant a symlink at .bak pointing to an unrelated file
          const innocentTarget = path.join(path.dirname(configPath), "innocent.txt");
          await fsp.writeFile(innocentTarget, "should not be read", "utf-8");
          await fsp.symlink(innocentTarget, `${configPath}.bak`);

          // .bak.1 is a real valid backup
          await seedConfig(`${configPath}.bak.1`, { gateway: { mode: "local" } });
          await seedConfig(configPath, { env: { shellEnv: { vars: { HOME: "/bad" } } } });

          const result = maybeRecoverFromSchemaInvalidConfigSync({
            deps,
            configPath,
            validate: validateHasGatewayMode,
          });

          // Should have fallen through to .bak.1, skipping the symlink at .bak
          expect(result).toBe(true);
          expect(warn).toHaveBeenCalledWith(expect.stringContaining(".bak.1"));
          // The symlink target must not have been overwritten
          await expect(fsp.readFile(innocentTarget, "utf-8")).resolves.toBe("should not be read");
        });
      },
    );

    it.skipIf(IS_WINDOWS)(
      "aborts recovery when the primary config path is a symlink (CWE-59 / TOCTOU guard)",
      async () => {
        await withSuiteHome(async (home) => {
          const { deps, configPath, warn } = makeDeps(home);

          await fsp.mkdir(path.dirname(configPath), { recursive: true });

          // configPath is a symlink to an unrelated file
          const sensitiveTarget = path.join(path.dirname(configPath), "sensitive.txt");
          await fsp.writeFile(sensitiveTarget, "do not overwrite", "utf-8");
          await fsp.symlink(sensitiveTarget, configPath);

          await seedConfig(`${configPath}.bak`, { gateway: { mode: "local" } });

          const result = maybeRecoverFromSchemaInvalidConfigSync({
            deps,
            configPath,
            validate: validateHasGatewayMode,
          });

          expect(result).toBe(false);
          expect(warn).not.toHaveBeenCalled();
          // The symlink target must be intact
          await expect(fsp.readFile(sensitiveTarget, "utf-8")).resolves.toBe("do not overwrite");
        });
      },
    );

    it("skips backup candidates that exceed the size limit (CWE-400 guard)", async () => {
      await withSuiteHome(async (home) => {
        const { deps, configPath, warn } = makeDeps(home);

        // Oversize .bak (exceeds RECOVERY_MAX_BYTES = 10 MB)
        const oversizeContent = `{"x":"${"a".repeat(11 * 1024 * 1024)}"}`;
        await fsp.mkdir(path.dirname(configPath), { recursive: true });
        await fsp.writeFile(`${configPath}.bak`, oversizeContent, "utf-8");

        // .bak.1 is normal and valid
        await seedConfig(`${configPath}.bak.1`, { gateway: { mode: "local" } });
        await seedConfig(configPath, { env: { shellEnv: { vars: { HOME: "/bad" } } } });

        const result = maybeRecoverFromSchemaInvalidConfigSync({
          deps,
          configPath,
          validate: validateHasGatewayMode,
        });

        expect(result).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(".bak.1"));
      });
    });

    it("archives the corrupted config exactly once across multiple candidate attempts", async () => {
      await withSuiteHome(async (home) => {
        const { deps, configPath } = makeDeps(home);

        // .bak invalid, .bak.1 valid — two loop iterations before success
        await seedConfig(`${configPath}.bak`, { env: { shellEnv: { vars: { HOME: "/bad" } } } });
        await seedConfig(`${configPath}.bak.1`, { gateway: { mode: "local" } });
        await seedConfig(configPath, { env: { shellEnv: { vars: { HOME: "/bad" } } } });

        const result = maybeRecoverFromSchemaInvalidConfigSync({
          deps,
          configPath,
          validate: validateHasGatewayMode,
        });

        expect(result).toBe(true);
        const dir = path.dirname(configPath);
        const entries = await fsp.readdir(dir);
        const clobbered = entries.filter((e) => e.includes(".clobbered."));
        expect(clobbered).toHaveLength(1);
      });
    });
  });
});
