import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { cleanupRetainedPluginInstallGenerations } from "../../../gateway/server-retained-plugin-cleanup.js";
import { commitPluginInstallRecordsWithConfig } from "../../../plugins/install-record-commit.js";
import {
  loadInstalledPluginIndexInstallRecords,
  readPersistedInstalledPluginIndexInstallRecords,
} from "../../../plugins/installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndexRowSync } from "../../../plugins/installed-plugin-index-row.js";
import { resolveRetainedManagedNpmInstallMarkerPath } from "../../../plugins/managed-npm-retention.js";
import { withPluginLifecycleLease } from "../../../plugins/plugin-lifecycle-lease.js";
import { seedInstalledPluginIndex } from "../../../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../../../plugins/test-helpers/managed-npm-plugin.js";
import { runPluginUpdateAttempt } from "../../../plugins/update-attempt.js";
import * as pluginUpdates from "../../../plugins/update.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { repairMissingConfiguredPluginInstalls } from "./missing-configured-plugin-install.js";
import { runPostCorePluginConvergence } from "./post-core-plugin-convergence.js";

afterEach(() => vi.restoreAllMocks());

describe("post-core plugin persistence cancellation", () => {
  it("keeps restored indexed packages usable under a fresh owner after marker compensation is interrupted", async () => {
    await withOpenClawTestState({ label: "plugin-marker-fresh-owner" }, async (state) => {
      const cfg = { plugins: { enabled: false } };
      await state.writeConfig(cfg);
      const records: Record<string, PluginInstallRecord & { installPath: string }> = {};
      for (const pluginId of ["first-retained", "second-retained"]) {
        const installPath = writeManagedNpmPlugin({
          stateDir: state.stateDir,
          packageName: `@openclaw/${pluginId}`,
          pluginId,
          version: "1.0.0",
        });
        records[pluginId] = {
          source: "npm",
          spec: `@openclaw/${pluginId}@1.0.0`,
          installPath,
          version: "1.0.0",
          resolvedVersion: "1.0.0",
        };
      }
      await seedInstalledPluginIndex(records, {
        config: cfg,
        env: state.env,
      });
      const configBefore = fs.readFileSync(state.configPath, "utf8");
      const firstMarker = resolveRetainedManagedNpmInstallMarkerPath(
        expectDefined(records["first-retained"], "first retained record").installPath,
      );
      const secondMarker = resolveRetainedManagedNpmInstallMarkerPath(
        expectDefined(records["second-retained"], "second retained record").installPath,
      );
      const controller = new AbortController();
      const refusal = new Error("caller revoked during marker compensation");
      let restoredRow: ReturnType<typeof readPersistedInstalledPluginIndexRowSync>;
      const rm = fs.promises.rm.bind(fs.promises);
      const rmSpy = vi.spyOn(fs.promises, "rm").mockImplementation(async (file, options) => {
        await rm(file, options);
        if (file === firstMarker) {
          restoredRow = readPersistedInstalledPluginIndexRowSync({ env: state.env });
          controller.abort(refusal);
        }
      });
      await expect(
        withPluginLifecycleLease(
          { env: state.env, assertCurrent: () => controller.signal.throwIfAborted() },
          async () =>
            commitPluginInstallRecordsWithConfig({
              previousInstallRecords: records,
              nextInstallRecords: {},
              nextConfig: { ...cfg, gateway: { port: 18792 } },
              writeOptions: {
                beforeCommit: () => {
                  throw new Error("config commit failed");
                },
              },
            }),
        ),
      ).rejects.toBe(refusal);
      rmSpy.mockRestore();
      expect(restoredRow).toBeDefined();
      expect(readPersistedInstalledPluginIndexRowSync({ env: state.env })).toEqual(restoredRow);
      expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(records);
      expect(fs.existsSync(firstMarker)).toBe(false);
      expect(fs.existsSync(secondMarker)).toBe(true);
      expect(fs.readFileSync(state.configPath, "utf8")).toBe(configBefore);

      // The old operation stays revoked. New ownership and fresh metadata, not saved
      // compensation snapshots, authorize continuation of the restored index.
      await withPluginLifecycleLease({ env: state.env }, async (lease) => {
        const freshRecords = await loadInstalledPluginIndexInstallRecords({ env: state.env });
        expect(freshRecords).toEqual(records);
        const result = await runPostCorePluginConvergence({
          cfg,
          env: state.env,
          baselineInstallRecords: freshRecords,
          beforePersistentEffect: () => lease.assertOwned(),
        });
        expect(result.errored).toBe(false);
        expect(result.warnings).toEqual([]);
        expect(result.installRecords).toEqual(records);
      });
      const log = { info: vi.fn(), warn: vi.fn() };
      await cleanupRetainedPluginInstallGenerations({ log, startupInstallPaths: [] });
      expect(controller.signal.aborted).toBe(true);
      for (const record of Object.values(records)) {
        expect(fs.readFileSync(path.join(record.installPath, "dist", "index.js"), "utf8")).toBe(
          "export {};\n",
        );
      }
      expect(log.info).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])("preserves the repair index when cancelled=%s", async (cancelled) => {
    await withOpenClawTestState({ label: "plugin-repair-cancellation" }, async (state) => {
      const cfg = { plugins: { enabled: false } };
      const previous: Record<string, PluginInstallRecord> = { previous: { source: "archive" } };
      const next: Record<string, PluginInstallRecord> = { next: { source: "archive" } };
      await seedInstalledPluginIndex(previous, {
        config: cfg,
        env: state.env,
      });
      const controller = new AbortController();
      const refusal = new Error("initiating operation cancelled during repair");
      await withPluginLifecycleLease({ env: state.env }, async () => {
        const params = {
          cfg,
          env: state.env,
          baselineRecords: next,
          beforePersistentEffect: () => controller.signal.throwIfAborted(),
        };
        const repair = repairMissingConfiguredPluginInstalls(params);
        if (cancelled) {
          controller.abort(refusal);
          await expect(repair).rejects.toBe(refusal);
        } else {
          await repair;
        }
      });
      expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(
        cancelled ? previous : next,
      );
    });
  });

  it("retains an initiating-owner read failure across install error normalization", async () => {
    await withOpenClawTestState({ label: "plugin-repair-normalized-refusal" }, async (state) => {
      const cfg = { plugins: { entries: { peerplugin: { enabled: true } } } };
      const record = {
        source: "npm" as const,
        spec: "peerplugin@1.0.0",
        installPath: state.statePath("extensions", "peerplugin"),
      };
      await seedInstalledPluginIndex({}, { config: cfg, env: state.env });
      const refusal = new Error("initiating-owner store read failed");
      let checks = 0;
      vi.spyOn(pluginUpdates, "updateNpmInstalledPlugins").mockImplementationOnce(
        async (params) => {
          // The real attempt owner catches installer exceptions. No package child is launched here.
          const attempt = await runPluginUpdateAttempt({
            pluginId: "peerplugin",
            record,
            config: params.config,
            dryRun: false,
            effectiveSpec: record.spec,
            trustedSourceLinkedOfficialInstall: false,
            logger: {},
            installNpmSpecForUpdate: async () => {
              await Promise.resolve();
              await params.beforePersistentEffect?.();
              return { ok: false, error: "fixture installer did not publish" };
            },
          });
          if (attempt.kind !== "exception") {
            throw new Error("fixture expected normalized refusal");
          }
          expect(attempt.error).toBe(refusal);
          return {
            config: params.config,
            changed: false,
            outcomes: [{ pluginId: "peerplugin", status: "error", message: attempt.message }],
          };
        },
      );
      const repair = repairMissingConfiguredPluginInstalls({
        cfg,
        env: state.env,
        baselineRecords: { peerplugin: record },
        beforePersistentEffect: () => {
          if (checks++ === 0) {
            throw refusal;
          }
        },
      });
      await expect(repair).rejects.toBe(refusal);
      expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual({});
    });
  });

  it.each(["missing-modules", "stale-link", "package-copy"] as const)(
    "submits real host-link effects in the synchronous admission turn: %s",
    async (layout) => {
      await withOpenClawTestState({ label: `plugin-sync-admission-${layout}` }, async (state) => {
        const packageDir = state.statePath("npm", "node_modules", "peer-plugin");
        const nodeModules = path.join(packageDir, "node_modules");
        const linkPath = path.join(nodeModules, "openclaw");
        fs.mkdirSync(packageDir, { recursive: true });
        fs.writeFileSync(
          path.join(packageDir, "package.json"),
          JSON.stringify({ name: "peer-plugin", peerDependencies: { openclaw: "*" } }),
        );
        if (layout !== "missing-modules") {
          fs.mkdirSync(nodeModules);
          if (layout === "stale-link") {
            fs.symlinkSync(state.root, linkPath, "junction");
          } else {
            fs.mkdirSync(linkPath);
            fs.writeFileSync(path.join(linkPath, "package.json"), '{"name":"openclaw"}');
          }
        }
        let inAdmissionTurn = false;
        const observations: Array<{ effect: string; admitted: boolean }> = [];
        const observe = (effect: string, target: unknown) => {
          if (target === nodeModules || target === linkPath) {
            observations.push({ effect, admitted: inAdmissionTurn });
          }
        };
        const mkdir = fs.promises.mkdir.bind(fs.promises);
        vi.spyOn(fs.promises, "mkdir").mockImplementation((...args) => {
          observe("mkdir", args[0]);
          return mkdir(...args);
        });
        const unlink = fs.promises.unlink.bind(fs.promises);
        vi.spyOn(fs.promises, "unlink").mockImplementation((...args) => {
          observe("unlink", args[0]);
          return unlink(...args);
        });
        const rm = fs.promises.rm.bind(fs.promises);
        vi.spyOn(fs.promises, "rm").mockImplementation((...args) => {
          observe("rm", args[0]);
          return rm(...args);
        });
        const symlink = fs.promises.symlink.bind(fs.promises);
        vi.spyOn(fs.promises, "symlink").mockImplementation((...args) => {
          observe("symlink", args[1]);
          return symlink(...args);
        });
        await runPostCorePluginConvergence({
          cfg: { plugins: { enabled: false } },
          env: state.env,
          baselineInstallRecords: {},
          beforePersistentEffect: () => {
            // Observe the submission turn; no lease, filesystem result or clock is mocked.
            inAdmissionTurn = true;
            queueMicrotask(() => {
              inAdmissionTurn = false;
            });
          },
        });
        expect(observations).toEqual([
          {
            effect:
              layout === "missing-modules" ? "mkdir" : layout === "stale-link" ? "unlink" : "rm",
            admitted: true,
          },
          { effect: "symlink", admitted: true },
        ]);
        expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
        expect(fs.realpathSync(linkPath)).not.toBe(fs.realpathSync(state.root));
      });
    },
  );

  it.each([
    ["managed", "mkdir"],
    ["managed", "unlink"],
    ["managed", "rm"],
    ["managed", "symlink"],
    ["registered", "unlink"],
  ] as const)(
    "keeps refusal blocking before the actual %s host-link %s effect",
    async (layout, effect) => {
      await withOpenClawTestState({ label: `plugin-host-${effect}` }, async (state) => {
        const cfg = { plugins: { enabled: false } };
        const packageDir =
          layout === "managed"
            ? state.statePath("npm", "node_modules", "peer-plugin")
            : state.statePath("extensions", "peer-plugin");
        const nodeModules = path.join(packageDir, "node_modules");
        const linkPath = path.join(nodeModules, "openclaw");
        fs.mkdirSync(packageDir, { recursive: true });
        fs.writeFileSync(
          path.join(packageDir, "package.json"),
          JSON.stringify({
            name: "peer-plugin",
            version: "1.0.0",
            peerDependencies: { openclaw: "*" },
          }),
        );
        if (effect !== "mkdir") {
          fs.mkdirSync(nodeModules, { recursive: true });
          if (effect === "rm") {
            fs.mkdirSync(linkPath);
            fs.writeFileSync(path.join(linkPath, "package.json"), '{"name":"openclaw"}');
          } else {
            fs.symlinkSync(state.root, linkPath, "junction");
          }
        }
        const controller = new AbortController();
        const refusal = new Error("initiating operation revoked after host-link probe");
        if (effect === "symlink") {
          const unlink = fs.promises.unlink.bind(fs.promises);
          vi.spyOn(fs.promises, "unlink").mockImplementation(async (file) => {
            await unlink(file);
            if (file === linkPath) {
              controller.abort(refusal);
            }
          });
        } else {
          const lstat = fs.promises.lstat.bind(fs.promises);
          vi.spyOn(fs.promises, "lstat").mockImplementation(async (...args) => {
            try {
              return await lstat(...args);
            } finally {
              if (args[0] === (effect === "mkdir" ? nodeModules : linkPath)) {
                controller.abort(refusal);
              }
            }
          });
        }
        const baselineInstallRecords: Record<string, PluginInstallRecord> =
          layout === "managed"
            ? {}
            : {
                "peer-plugin": {
                  source: "npm",
                  spec: "peer-plugin@1.0.0",
                  installPath: packageDir,
                },
              };
        let refused = false;
        const params = {
          cfg,
          env: state.env,
          baselineInstallRecords,
          beforePersistentEffect: () => {
            if (controller.signal.aborted && !refused) {
              refused = true;
              throw controller.signal.reason;
            }
          },
        };
        await expect(runPostCorePluginConvergence(params)).rejects.toBe(refusal);
        if (effect === "mkdir") {
          expect(fs.existsSync(nodeModules)).toBe(false);
        } else if (effect === "symlink") {
          expect(fs.existsSync(linkPath)).toBe(false);
        } else if (effect === "rm") {
          expect(fs.readFileSync(path.join(linkPath, "package.json"), "utf8")).toBe(
            '{"name":"openclaw"}',
          );
          expect(fs.lstatSync(linkPath).isDirectory()).toBe(true);
        } else {
          expect(fs.readlinkSync(linkPath)).toBe(state.root);
        }
      });
    },
  );
});
