import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "./io.runtime.js";
import { transformConfigFile } from "./mutate.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import { withEnvOverride, withTempHome, writeOpenClawConfig } from "./test-helpers.js";
import {
  getConfigFileWriteCapture,
  recordConfigFileWrite,
  withConfigFileWriteCapture,
} from "./write-capture.js";

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

afterEach(() => {
  setRuntimeConfigSnapshotRefreshHandler(null);
  clearRuntimeConfigSnapshot();
  closeOpenClawStateDatabaseForTest();
});

describe("config file write ownership", () => {
  it("shares nested captures and permanently marks an interrupted ownership chain", async () => {
    const target = path.resolve("fixture/config.json");
    expect(getConfigFileWriteCapture()).toBeUndefined();
    await withConfigFileWriteCapture(async (writes) => {
      recordConfigFileWrite(target, null, "first");
      await withConfigFileWriteCapture(async (nested) => {
        expect(nested).toBe(writes);
        recordConfigFileWrite(target, "first", "second");
      });
      expect(writes.get(target)).toEqual({
        path: target,
        beforeHash: null,
        afterHash: "second",
        contiguous: true,
      });
      recordConfigFileWrite(target, "second", null);
      expect(writes.get(target)?.afterHash).toBeNull();
      recordConfigFileWrite(target, null, "third");
      expect(writes.get(target)?.contiguous).toBe(true);
      recordConfigFileWrite(target, "operator-edit", "fourth");
      recordConfigFileWrite(target, "fourth", "fifth");
      expect(writes.get(target)).toEqual({
        path: target,
        beforeHash: null,
        afterHash: "fifth",
        contiguous: false,
      });
    });
    expect(getConfigFileWriteCapture()).toBeUndefined();
  });

  it("captures exact root and include bytes through the real config transformer", async () => {
    await withTempHome(async (home) => {
      await withEnvOverride(
        { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_TEST_FAST: "1" },
        async () => {
          const configPath = await writeOpenClawConfig(home, {
            gateway: { mode: "local" },
            browser: { $include: "./browser.json5" },
          });
          const includePath = path.join(path.dirname(configPath), "browser.json5");
          const includeBefore = "{ /* authored fragment */ enabled: false }\n";
          await fs.writeFile(includePath, includeBefore);
          const rootBefore = await fs.readFile(configPath, "utf8");
          await withConfigFileWriteCapture(async (writes) => {
            await transformConfigFile({
              base: "source",
              writeOptions: {
                skipPluginValidation: true,
                skipRuntimeSnapshotRefresh: true,
                skipOutputLogs: true,
              },
              transform: (config) => ({
                nextConfig: { ...config, browser: { ...config.browser, enabled: true } },
              }),
            });
            const includeAfter = await fs.readFile(includePath, "utf8");
            expect(writes.get(includePath)).toEqual({
              path: includePath,
              beforeHash: hash(includeBefore),
              afterHash: hash(includeAfter),
              contiguous: true,
            });
            expect(writes.has(configPath)).toBe(false);
            expect(await fs.readFile(configPath, "utf8")).toBe(rootBefore);
            await transformConfigFile({
              base: "source",
              writeOptions: {
                skipPluginValidation: true,
                skipRuntimeSnapshotRefresh: true,
                skipOutputLogs: true,
              },
              transform: (config) => ({
                nextConfig: { ...config, gateway: { ...config.gateway, port: 19701 } },
              }),
            });
            expect(writes.get(configPath)).toEqual({
              path: configPath,
              beforeHash: hash(rootBefore),
              afterHash: hash(await fs.readFile(configPath, "utf8")),
              contiguous: true,
            });
          });
        },
      );
    });
  });

  it.each([false, true])(
    "publishes root receipts only after runtime validation succeeds (reject=%s)",
    async (reject) => {
      await withTempHome(async (home) => {
        await withEnvOverride(
          { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_TEST_FAST: "1" },
          async () => {
            const configPath = await writeOpenClawConfig(home, {
              gateway: { mode: "local", port: 19700 },
            });
            const before = await fs.readFile(configPath, "utf8");
            const { snapshot } = await readConfigFileSnapshotForWrite();
            setRuntimeConfigSnapshot(snapshot.config, snapshot.sourceConfig);
            await withConfigFileWriteCapture(async (writes) => {
              setRuntimeConfigSnapshotRefreshHandler({
                preflight: ({ sourceConfig }) => ({ sourceConfig }),
                refresh: async () => {
                  expect(writes.has(configPath)).toBe(false);
                  if (reject) {
                    throw new Error("synthetic refresh failure");
                  }
                  return true;
                },
              });
              const write = writeConfigFile(
                { ...snapshot.config, gateway: { mode: "local", port: 19701 } },
                { skipPluginValidation: true, skipOutputLogs: true },
              );
              if (reject) {
                await expect(write).rejects.toThrow("synthetic refresh failure");
                expect(await fs.readFile(configPath, "utf8")).toBe(before);
                expect(writes.size).toBe(0);
              } else {
                await write;
                expect(writes.get(configPath)).toEqual({
                  path: configPath,
                  beforeHash: hash(before),
                  afterHash: hash(await fs.readFile(configPath, "utf8")),
                  contiguous: true,
                });
              }
            });
          },
        );
      });
    },
  );
});
