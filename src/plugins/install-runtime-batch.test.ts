import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import { PluginInstallRuntimeBatch } from "./install-runtime-batch.js";
import { inspectPluginGenerationSources } from "./plugin-generation-source-inspection.js";
import { hasPluginLifecycleLease, withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);

it.each(["runtime", "source", "record", "closed", "adopted", "loadpath", "rebound"])(
  "retains replaced source when the post-lease handoff loses %s ownership",
  async (failure) => {
    const root = dirs.make("plugin-batch-gap-");
    const source = path.join(root, "current");
    const previousSource = path.join(root, "previous");
    await fs.mkdir(source);
    await fs.mkdir(previousSource);
    await fs.writeFile(path.join(source, "index.ts"), "export const value = 1;");
    await fs.writeFile(path.join(source, "package.json"), "{}");
    const env = {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
    await withEnvAsync(env, async () => {
      const records = { fixture: { source: "path" as const, installPath: source, version: "1" } };
      const cleanup = vi.fn(async (assertOwned: () => void) => {
        assertOwned();
        await fs.rm(previousSource, { recursive: true });
      });
      const reload = vi.fn(async () => {
        expect(hasPluginLifecycleLease()).toBe(false);
        if (failure === "runtime") {
          throw new Error("runtime reply lost");
        }
        if (failure === "source") {
          await fs.writeFile(path.join(source, "index.ts"), "export const value = 2;");
        } else if (failure === "record" || failure === "adopted") {
          await withPluginLifecycleLease({ env }, () =>
            commitPluginInstallRecordsWithConfig({
              previousInstallRecords: records,
              nextInstallRecords:
                failure === "record"
                  ? { fixture: { ...records.fixture, version: "2" } }
                  : {
                      ...records,
                      adopter: {
                        source: "path",
                        sourcePath: previousSource,
                        installPath: previousSource,
                      },
                    },
              nextConfig: {},
              writeOptions: { afterWrite: { mode: "none", reason: "replacement fixture" } },
            }),
          );
        } else if (failure === "loadpath") {
          await fs.writeFile(
            env.OPENCLAW_CONFIG_PATH,
            JSON.stringify({ plugins: { load: { paths: [previousSource] } } }),
          );
        } else if (failure === "rebound") {
          await fs.rename(previousSource, path.join(root, "retired-original"));
          await fs.mkdir(previousSource);
        } else if (failure === "closed") {
          batch.close();
        }
        return { operationId: "handoff", generation: 2, pluginIds: ["fixture"] };
      });
      const batch = new PluginInstallRuntimeBatch({ env }, reload);
      const deferred = batch.install();
      await withPluginLifecycleLease({ env }, async (lease) => {
        const captured = inspectPluginGenerationSources([{ pluginId: "fixture", rootDir: source }]);
        const write = await commitPluginInstallRecordsWithConfig({
          previousInstallRecords: {},
          nextInstallRecords: records,
          nextConfig: {},
          writeOptions: { afterWrite: { mode: "none", reason: "batch fixture" } },
        });
        deferred.record(
          {
            operation: "install",
            pluginId: "fixture",
            sourceDigests: captured.sourceDigests,
            write,
          },
          captured.assertSourceCurrent,
        );
        deferred.deferCleanup(cleanup, previousSource);
        batch.prepare(lease);
      });
      await expect(batch.finish(() => {})).rejects.toThrow(
        failure === "runtime" ? "Runtime activation was not confirmed" : "source cleanup failed",
      );
      expect(reload).toHaveBeenCalledOnce();
      expect(cleanup).not.toHaveBeenCalled();
      await expect(fs.stat(previousSource)).resolves.toBeDefined();
      expect(() => deferred.deferCleanup(cleanup, previousSource)).toThrow(
        "no longer accepts mutations",
      );
      await expect(batch.finish(() => {})).rejects.toThrow("handoff already started");
    });
  },
);
