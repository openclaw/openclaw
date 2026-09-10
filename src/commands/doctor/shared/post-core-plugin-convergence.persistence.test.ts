import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import {
  readPersistedInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../../plugins/plugin-lifecycle-lease.js";
import { runPluginUpdateAttempt } from "../../../plugins/update-attempt.js";
import * as pluginUpdates from "../../../plugins/update.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { repairMissingConfiguredPluginInstalls } from "./missing-configured-plugin-install.js";
import { runPostCorePluginConvergence } from "./post-core-plugin-convergence.js";

afterEach(() => vi.restoreAllMocks());

describe("post-core plugin persistence cancellation", () => {
  it.each([false, true])("preserves the repair index when cancelled=%s", async (cancelled) => {
    await withOpenClawTestState({ label: "plugin-repair-cancellation" }, async (state) => {
      const cfg = { plugins: { enabled: false } };
      const previous: Record<string, PluginInstallRecord> = { previous: { source: "archive" } };
      const next: Record<string, PluginInstallRecord> = { next: { source: "archive" } };
      await writePersistedInstalledPluginIndexInstallRecords(previous, {
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
      expect(await readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(
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
      await writePersistedInstalledPluginIndexInstallRecords({}, { config: cfg, env: state.env });
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
      expect(await readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual({});
    });
  });

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
        const params = {
          cfg,
          env: state.env,
          baselineInstallRecords,
          beforePersistentEffect: () => controller.signal.throwIfAborted(),
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
