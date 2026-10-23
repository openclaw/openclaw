import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, expect, it as baseIt, vi } from "vitest";
import { withUpdateCommandExecutor } from "../../../cli/update-cli/update-command-executor.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { cleanupGatewayRetiredPluginArtifacts } from "../../../gateway/server-retained-plugin-cleanup.js";
import * as temporaryState from "../../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../../infra/update-run-ledger.js";
import { commitPluginInstallRecordsWithConfig } from "../../../plugins/install-record-commit.js";
import * as pluginInstaller from "../../../plugins/install.js";
import {
  loadInstalledPluginIndexInstallRecords,
  readPersistedInstalledPluginIndexInstallRecordsAsync as readRecords,
} from "../../../plugins/installed-plugin-index-records.js";
import { resolveRetainedManagedNpmInstallMarkerPath } from "../../../plugins/managed-npm-retention.js";
import { withPluginLifecycleLease } from "../../../plugins/plugin-lifecycle-lease.js";
import {
  readPersistedInstalledPluginIndexRowSync as readRow,
  seedInstalledPluginIndex,
} from "../../../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../../../plugins/test-helpers/managed-npm-plugin.js";
import { runPluginUpdateAttempt } from "../../../plugins/update-attempt.js";
import * as pluginUpdates from "../../../plugins/update.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { repairMissingConfiguredPluginInstalls } from "./missing-configured-plugin-install.js";
import { runPostCorePluginConvergence } from "./post-core-plugin-convergence.js";

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

const it = baseIt.extend<{ state: OpenClawTestState }>({
  state: async ({ task }, use) => withOpenClawTestState({ label: task.name }, use),
});
type Layout = "managed" | "registered";

function createPeerPlugin(
  state: OpenClawTestState,
  layout: Layout = "managed",
  contents: "missing-modules" | "stale-link" | "package-copy" = "stale-link",
) {
  const packageDir =
    layout === "managed"
      ? state.statePath("npm", "node_modules", "peer-plugin")
      : state.statePath("extensions", "peer-plugin");
  const nodeModules = path.join(packageDir, "node_modules");
  const linkPath = path.join(nodeModules, "openclaw");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "peer-plugin", version: "1.0.0", peerDependencies: { openclaw: "*" } }),
  );
  const baselineInstallRecords: Record<string, PluginInstallRecord> = {
    "peer-plugin": { source: "npm", spec: "peer-plugin@1.0.0", installPath: packageDir },
  };
  if (contents !== "missing-modules") {
    fs.mkdirSync(nodeModules);
    if (contents === "stale-link") {
      fs.symlinkSync(state.root, linkPath, "junction");
    } else {
      fs.mkdirSync(linkPath);
      fs.writeFileSync(path.join(linkPath, "package.json"), '{"name":"openclaw"}');
    }
  }
  return {
    nodeModules,
    linkPath,
    params: { cfg: { plugins: { enabled: false } }, env: state.env, baselineInstallRecords },
  };
}

it.for(["managed", "registered"] as const)(
  "fences %s host-link effects when only the raw plugin lease is revoked",
  async (layout, { state }) => {
    const peer = createPeerPlugin(state, layout);
    const { linkPath } = peer;
    await state.writeConfig(peer.params.cfg);
    const control = state.path("control");
    fs.mkdirSync(control);
    vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const configBefore = fs.readFileSync(state.configPath, "utf8");
    const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      const fence = await executor.enter(state.root, { preflight: true });
      const controller = new AbortController();
      let revocations = 0;
      let rowAtRevocation: ReturnType<typeof readRow>;
      const revoke = () => {
        if (controller.signal.aborted) {
          return;
        }
        revocations += 1;
        rowAtRevocation = readRow({ env: state.env });
        controller.abort(new Error("plugin lease revoked while updater remains current"));
      };
      const unlink = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
        unlink(file);
        if (layout === "managed" && file === linkPath) {
          revoke();
        }
      });
      const lstat = fs.promises.lstat.bind(fs.promises);
      const lstatSpy = vi.spyOn(fs.promises, "lstat").mockImplementation(async (...args) => {
        const result = await lstat(...args);
        if (layout === "registered" && args[0] === linkPath) {
          revoke();
        }
        return result;
      });
      const symlinkSpy = vi.spyOn(fs, "symlinkSync");
      syncBuiltinESMExports();
      const params = {
        ...peer.params,
        beforePersistentEffect: fence.assertCurrent,
      };
      try {
        await expect(
          withPluginLifecycleLease({ env: state.env, signal: controller.signal }, () =>
            runPostCorePluginConvergence(params),
          ),
        ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
        expect({ aborted: controller.signal.aborted, revocations }).toEqual({
          aborted: true,
          revocations: 1,
        });
        expect(() => fence.assertCurrent()).not.toThrow();
        expect(unlinkSpy.mock.calls.filter(([file]) => file === linkPath)).toHaveLength(
          layout === "managed" ? 1 : 0,
        );
        expect(symlinkSpy.mock.calls.filter(([, target]) => target === linkPath)).toHaveLength(0);
        if (layout === "managed") {
          expect(fs.existsSync(linkPath)).toBe(false);
        } else {
          expect(fs.readlinkSync(linkPath)).toBe(state.root);
        }
        expect(rowAtRevocation).toBeDefined();
        expect(readRow({ env: state.env })).toEqual(rowAtRevocation);
        expect(fs.readFileSync(state.configPath, "utf8")).toBe(configBefore);
      } finally {
        unlinkSpy.mockRestore();
        lstatSpy.mockRestore();
        symlinkSpy.mockRestore();
        syncBuiltinESMExports();
      }

      const fresh = await runPostCorePluginConvergence(params);
      expect(fresh).toMatchObject({ errored: false, warnings: [] });
      expect(fresh.changes.length).toBeGreaterThan(0);
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(linkPath)).not.toBe(fs.realpathSync(state.root));
      expect(() => fence.assertCurrent()).not.toThrow();
    });
  },
);

it("keeps restored indexed packages usable under a fresh owner after marker compensation is interrupted", async ({
  state,
}) => {
  const cfg = { plugins: { enabled: false } };
  await state.writeConfig(cfg);
  const records: Record<string, PluginInstallRecord & { installPath: string }> = {};
  const markerPaths: string[] = [];
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
    markerPaths.push(resolveRetainedManagedNpmInstallMarkerPath(installPath));
  }
  await seedInstalledPluginIndex(records, { config: cfg, env: state.env });
  const configBefore = fs.readFileSync(state.configPath, "utf8");
  const controller = new AbortController();
  const refusal = new Error("caller revoked during marker compensation");
  let restoredRow: ReturnType<typeof readRow>;
  const rm = fs.promises.rm.bind(fs.promises);
  const rmSpy = vi.spyOn(fs.promises, "rm").mockImplementation(async (file, options) => {
    await rm(file, options);
    if (file === markerPaths[0]) {
      restoredRow = readRow({ env: state.env });
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
  expect(readRow({ env: state.env })).toEqual(restoredRow);
  expect(await readRecords({ env: state.env })).toEqual(records);
  expect(markerPaths.map((marker) => fs.existsSync(marker))).toEqual([false, true]);
  expect(fs.readFileSync(state.configPath, "utf8")).toBe(configBefore);

  // Continuation needs fresh ownership and metadata, not saved compensation snapshots.
  await withPluginLifecycleLease({ env: state.env }, async (lease) => {
    const freshRecords = await loadInstalledPluginIndexInstallRecords({ env: state.env });
    expect(freshRecords).toEqual(records);
    const result = await runPostCorePluginConvergence({
      cfg,
      env: state.env,
      baselineInstallRecords: freshRecords,
      beforePersistentEffect: () => lease.assertOwned(),
    });
    expect(result).toMatchObject({ errored: false, warnings: [] });
    expect(result.installRecords).toEqual(records);
  });
  const log = { info: vi.fn(), warn: vi.fn() };
  await cleanupGatewayRetiredPluginArtifacts({
    log,
    startupInstallPaths: [],
    signal: new AbortController().signal,
    assertCurrent: () => {},
  });
  expect(controller.signal.aborted).toBe(true);
  for (const record of Object.values(records)) {
    expect(fs.readFileSync(path.join(record.installPath, "dist", "index.js"), "utf8")).toBe(
      "export {};\n",
    );
  }
  expect(log.info).not.toHaveBeenCalled();
  expect(log.warn).not.toHaveBeenCalled();
});

it("preserves the repair index when cancelled", async ({ state }) => {
  const cfg = { plugins: { enabled: false } };
  const previous: Record<string, PluginInstallRecord> = { previous: { source: "archive" } };
  const next: Record<string, PluginInstallRecord> = { next: { source: "archive" } };
  await seedInstalledPluginIndex(previous, { config: cfg, env: state.env });
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
    controller.abort(refusal);
    await expect(repair).rejects.toBe(refusal);
  });
  expect(await readRecords({ env: state.env })).toEqual(previous);
});

it("retains an initiating-owner read failure across install error normalization", async ({
  state,
}) => {
  const cfg = { plugins: { entries: { peerplugin: { enabled: true } } } };
  const record = {
    source: "npm" as const,
    spec: "peerplugin@1.0.0",
    installPath: state.statePath("extensions", "peerplugin"),
  };
  await seedInstalledPluginIndex({}, { config: cfg, env: state.env });
  const refusal = new Error("initiating-owner store read failed");
  let checks = 0;
  vi.spyOn(pluginUpdates, "updateNpmInstalledPlugins").mockImplementationOnce(async (params) => {
    // The real attempt owner catches installer exceptions. No package child is launched here.
    vi.spyOn(pluginInstaller, "installPluginFromNpmSpec").mockImplementationOnce(async () => {
      await Promise.resolve();
      await params.beforePersistentEffect?.();
      return { ok: false, error: "fixture installer did not publish" };
    });
    const attempt = await runPluginUpdateAttempt({
      pluginId: "peerplugin",
      record,
      config: params.config,
      dryRun: false,
      effectiveSpec: record.spec,
      trustedSourceLinkedOfficialInstall: false,
      logger: {},
      onNpmInstall: () => {},
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
  });
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
  expect(await readRecords({ env: state.env })).toEqual({});
});

it.for(["missing-modules", "stale-link", "package-copy"] as const)(
  "submits real host-link effects in the synchronous admission turn: %s",
  async (layout, { state }) => {
    const { nodeModules, linkPath, params } = createPeerPlugin(state, "managed", layout);
    let inAdmissionTurn = false;
    const observations: Array<[effect: string, admitted: boolean]> = [];
    const observe = (effect: string, target: unknown) => {
      if (target === nodeModules || target === linkPath) {
        observations.push([effect, inAdmissionTurn]);
      }
    };
    const mkdir = fs.promises.mkdir.bind(fs.promises);
    vi.spyOn(fs.promises, "mkdir").mockImplementation((...args) => {
      observe("mkdir", args[0]);
      return mkdir(...args);
    });
    const unlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((...args) => {
      observe("unlink", args[0]);
      return unlink(...args);
    });
    const rm = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, "rm").mockImplementation((...args) => {
      observe("rm", args[0]);
      return rm(...args);
    });
    const symlink = fs.symlinkSync.bind(fs);
    vi.spyOn(fs, "symlinkSync").mockImplementation((...args) => {
      observe("symlink", args[1]);
      return symlink(...args);
    });
    syncBuiltinESMExports();
    await runPostCorePluginConvergence({
      ...params,
      beforePersistentEffect: () => {
        // Observe the submission turn; no lease, filesystem result or clock is mocked.
        inAdmissionTurn = true;
        queueMicrotask(() => {
          inAdmissionTurn = false;
        });
      },
    });
    const firstEffect =
      layout === "missing-modules" ? "mkdir" : layout === "stale-link" ? "unlink" : "rm";
    expect(observations).toEqual([
      [firstEffect, true],
      ["symlink", true],
    ]);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linkPath)).not.toBe(fs.realpathSync(state.root));
  },
);

it.for(["managed", "registered"] as const)(
  "keeps refusal blocking during %s host-link replacement",
  async (layout, { state }) => {
    const { linkPath, params } = createPeerPlugin(state, layout);
    const controller = new AbortController();
    const refusal = new Error("initiating operation revoked after host-link probe");
    if (layout === "registered") {
      const lstat = fs.promises.lstat.bind(fs.promises);
      vi.spyOn(fs.promises, "lstat").mockImplementation(async (...args) => {
        try {
          return await lstat(...args);
        } finally {
          if (args[0] === linkPath) {
            controller.abort(refusal);
          }
        }
      });
    } else {
      const unlink = fs.unlinkSync.bind(fs);
      vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
        unlink(target);
        if (target === linkPath) {
          controller.abort(refusal);
        }
      });
      syncBuiltinESMExports();
    }
    let refused = false;
    await expect(
      runPostCorePluginConvergence({
        ...params,
        beforePersistentEffect: () => {
          if (controller.signal.aborted && !refused) {
            refused = true;
            throw controller.signal.reason;
          }
        },
      }),
    ).rejects.toBe(refusal);
    if (layout === "managed") {
      expect(fs.existsSync(linkPath)).toBe(false);
    } else {
      expect(fs.readlinkSync(linkPath)).toBe(state.root);
    }
  },
);
