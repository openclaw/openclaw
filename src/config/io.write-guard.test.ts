import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConfigIO } from "./io.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";

function makeRichConfig(): OpenClawConfig {
  return {
    meta: {
      lastTouchedAt: "2026-05-01T00:00:00.000Z",
      lastTouchedVersion: "0.0.0-test",
    },
    update: { channel: "beta" },
    gateway: { mode: "local" },
    env: {
      vars: {
        OPENCLAW_TEST_CONFIG_PADDING: "x".repeat(1200),
      },
    },
  } as OpenClawConfig;
}

function makeTinyConfig(channel = "beta"): OpenClawConfig {
  return { update: { channel } } as OpenClawConfig;
}

function createPermissionDeniedError(configPath: string): NodeJS.ErrnoException {
  const err = new Error(`EACCES: permission denied, open '${configPath}'`) as NodeJS.ErrnoException;
  err.code = "EACCES";
  return err;
}

function createUnreadableConfigFs(configPath: string): typeof fs {
  const targetPath = path.resolve(configPath);
  const isConfigPath = (target: unknown): boolean =>
    typeof target === "string" && path.resolve(target) === targetPath;

  return {
    ...fs,
    readFileSync: ((target: Parameters<typeof fs.readFileSync>[0], options) => {
      if (isConfigPath(target)) {
        throw createPermissionDeniedError(configPath);
      }
      return fs.readFileSync(target, options);
    }) as typeof fs.readFileSync,
    promises: {
      ...fs.promises,
      readFile: (async (target: Parameters<typeof fsp.readFile>[0], options) => {
        if (isConfigPath(target)) {
          throw createPermissionDeniedError(configPath);
        }
        return await fsp.readFile(target, options);
      }) as typeof fs.promises.readFile,
    },
  } as typeof fs;
}

async function promoteLastKnownGood(params: {
  home: string;
  configPath: string;
  logger: Pick<typeof console, "error" | "warn">;
}): Promise<void> {
  const io = createConfigIO({
    configPath: params.configPath,
    env: {} as NodeJS.ProcessEnv,
    homedir: () => params.home,
    logger: params.logger,
  });
  const snapshot = await io.readConfigFileSnapshot();
  expect(snapshot.valid).toBe(true);
  await expect(io.promoteConfigSnapshotToLastKnownGood(snapshot)).resolves.toBe(true);
}

async function expectRejectedConfigWrite(
  run: () => Promise<unknown>,
): Promise<NodeJS.ErrnoException & { rejectedPath?: string; reasons?: string[] }> {
  try {
    await run();
  } catch (err) {
    const rejected = err as NodeJS.ErrnoException & { rejectedPath?: string; reasons?: string[] };
    expect(rejected.code).toBe("CONFIG_WRITE_REJECTED");
    expect(rejected.rejectedPath).toEqual(expect.stringContaining(".rejected."));
    expect(rejected.reasons).toEqual(expect.any(Array));
    return rejected;
  }
  throw new Error("Expected config write to be rejected");
}

describe("config write guard", () => {
  it("rejects best-effort writes after the config file cannot be read", async () => {
    await withTempHome(async (home) => {
      const logger = { error: vi.fn(), warn: vi.fn() };
      const configPath = await writeOpenClawConfig(home, makeRichConfig());
      const originalRaw = await fsp.readFile(configPath, "utf-8");
      await promoteLastKnownGood({ home, configPath, logger });

      const io = createConfigIO({
        configPath,
        env: {} as NodeJS.ProcessEnv,
        fs: createUnreadableConfigFs(configPath),
        homedir: () => home,
        logger,
      });

      const err = await expectRejectedConfigWrite(() => io.writeConfigFile(makeTinyConfig()));

      expect(err.reasons).toEqual(expect.arrayContaining(["unreadable-config-before-write"]));
      expect(err.reasons?.some((reason) => reason.startsWith("size-drop-vs-last-good:"))).toBe(
        true,
      );
      expect(err.reasons).toEqual(expect.arrayContaining(["gateway-mode-missing-vs-last-good"]));
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(originalRaw);
      await expect(fsp.readFile(err.rejectedPath ?? "", "utf-8")).resolves.toContain('"update"');
    });
  });

  it("rejects writes that would clobber the last-known-good config shape", async () => {
    await withTempHome(async (home) => {
      const logger = { error: vi.fn(), warn: vi.fn() };
      const configPath = await writeOpenClawConfig(home, makeRichConfig());
      await promoteLastKnownGood({ home, configPath, logger });
      const tinyRaw = `${JSON.stringify(makeTinyConfig(), null, 2)}\n`;
      await fsp.writeFile(configPath, tinyRaw, "utf-8");

      const io = createConfigIO({
        configPath,
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger,
      });

      const err = await expectRejectedConfigWrite(() =>
        io.writeConfigFile(makeTinyConfig("stable")),
      );

      expect(err.reasons?.some((reason) => reason.startsWith("size-drop-vs-last-good:"))).toBe(
        true,
      );
      expect(err.reasons).toEqual(expect.arrayContaining(["gateway-mode-missing-vs-last-good"]));
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(tinyRaw);
    });
  });
});
