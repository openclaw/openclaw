import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../../test/helpers/private-update-handoff-store.js";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import * as configMutations from "../../config/mutate.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
} from "../../config/runtime-snapshot.js";
import { captureConfigWriteLockGuard, withConfigWriteLock } from "../../config/write-lock.js";
import { acquireStateDatabaseCoordinator } from "../../infra/state-database-coordinator.js";
import { createManagedHandoffLeaseDatabase } from "../../infra/update-managed-service-handoff-database.js";
import * as captures from "../../infra/update-recovery-backup-create.js";
import { backupStore } from "../../infra/update-recovery-backup-files.js";
import { inspectUpdateRecoveryBackup } from "../../infra/update-recovery-backup-inventory.js";
import { prepareVerifiedBackup } from "../../infra/update-recovery-backup-verify.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { captureOriginalUpdateRecoveryBaseline } from "./update-command-recovery-baseline.js";
import {
  persistOriginalUpdateConfigWrites,
  withOriginalUpdateRecoveryCapture,
} from "./update-command-recovery-config.js";

afterEach(() => {
  vi.restoreAllMocks();
  setRuntimeConfigSnapshotRefreshHandler(null);
  clearRuntimeConfigSnapshot();
});

async function fixture(
  operation: (f: {
    root: string;
    stateDir: string;
    configPath: string;
    statePath: string;
    run: NonNullable<UpdateCommandOptions["run"]>;
    capture: (installRoot?: string) => ReturnType<typeof captureOriginalUpdateRecoveryBaseline>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const root = fs.realpathSync(state.root);
    const install = path.join(root, "install");
    fs.mkdirSync(install, { mode: 0o700 });
    fs.writeFileSync(path.join(install, "package.json"), '{"name":"openclaw","version":"1.0.0"}');
    await state.writeConfig({
      agents: { defaults: { workspace: state.workspaceDir } },
      plugins: { enabled: false },
    });
    const { databasePath, assertDatabasePath } = installPrivateUpdateHandoffStore(root);
    assertDatabasePath(databasePath);
    await (async () => {
      const env = { ...process.env };
      const runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
      const statePath = resolveOpenClawStateSqlitePath(env);
      createManagedHandoffLeaseDatabase(databasePath)(true, () => {});
      const identity = (file: string) => {
        const stat = fs.statSync(file, { bigint: true });
        return `${stat.dev}:${stat.ino}`;
      };
      const selectedDatabase = (file: string) => ({
        databasePath: file,
        databaseIdentity: identity(file),
        parentIdentity: identity(path.dirname(file)),
      });
      const selection = {
        privateRoot: { path: root, identity: identity(root) },
        installation: { path: install, identity: identity(install) },
        handoff: selectedDatabase(databasePath),
        state: selectedDatabase(statePath),
      };
      await closeOpenClawStateDatabaseByPathAsync(statePath);
      closeOpenClawStateDatabaseForTest();
      await withUpdateCommandExecutor(
        runId,
        async (executor) => {
          const run: NonNullable<UpdateCommandOptions["run"]> = {
            runId,
            env,
            executorFence: await executor.enter(install),
          };
          const original = run.executorFence!;
          const capture = async (installRoot = install) => {
            const ref = await captureOriginalUpdateRecoveryBaseline({
              opts: { run },
              env,
              installRoot,
              assertCallerCurrent() {
                original.assertCurrent();
              },
            });
            run.recoveryBaseline = ref;
            return ref;
          };
          await withOriginalUpdateRecoveryCapture({ run }, { triageTarget: { env } }, () =>
            operation({
              root,
              stateDir: state.stateDir,
              configPath: state.configPath,
              statePath,
              run,
              capture,
            }),
          );
        },
        {
          directOriginal: { databasePath },
          initialStores: { protocol: "initial-pair-v1", selection },
        },
      );
    })();
  });
}

it("captures original root/include config under stopped maintenance before later mutation", async () => {
  await fixture(async (f) => {
    const note = path.join(f.stateDir, "acknowledged.json");
    const beforeInclude = fs.readFileSync(f.configPath, "utf8");
    fs.writeFileSync(note, beforeInclude, { mode: 0o600 });
    fs.writeFileSync(f.configPath, JSON.stringify({ $include: "acknowledged.json" }));
    const beforeConfig = fs.readFileSync(f.configPath, "utf8");
    const actual = captures.captureUpdateRecoveryBackup;
    let maintenanceObserved = false;
    vi.spyOn(captures, "captureUpdateRecoveryBackup").mockImplementation(async (params) => {
      expect(getOpenClawDatabaseMaintenanceScope()).toBeDefined();
      maintenanceObserved = true;
      return actual(params);
    });
    const ref = await f.capture();
    expect(ref).toBeDefined();
    expect(maintenanceObserved).toBe(true);
    expect(
      getUpdateRun(f.run.runId, { env: f.run.env })?.origin.updateRecoveryCapture,
    ).toMatchObject({ manifestSha256: ref!.manifestSha256, status: "pending", configWrites: [] });
    const newerInclude = JSON.stringify({
      ...JSON.parse(beforeInclude),
      update: { channel: "dev" },
    });
    fs.writeFileSync(note, newerInclude);
    const verified = await prepareVerifiedBackup(ref!);
    try {
      for (const [sourcePath, expected] of [
        [note, beforeInclude],
        [f.configPath, beforeConfig],
      ]) {
        const entry = verified.manifest.entries.find((item) => item.sourcePath === sourcePath);
        expect(entry?.kind).toBe("file");
        if (entry?.kind !== "file") {
          throw new Error("Baseline omitted original acknowledged bytes");
        }
        expect(fs.readFileSync(verified.payloads.get(entry.archivePath)!, "utf8")).toBe(expected);
      }
      expect(fs.readFileSync(note, "utf8")).toBe(newerInclude);
    } finally {
      await verified.close();
    }
    await expect(f.capture()).rejects.toThrow("uncaptured, running original update");
    // Physical custody settles before returning; a real participating writer can reopen.
    acquireStateDatabaseCoordinator({ databasePath: f.statePath, busyTimeoutMs: 0 }).release();
  });
});

it("uses the selected managed environment for recovery resource discovery", async () => {
  await fixture(async (f) => {
    const selectedStateDir = path.join(f.root, "selected-state");
    fs.mkdirSync(selectedStateDir, { recursive: true });
    const env = { ...f.run.env, OPENCLAW_STATE_DIR: selectedStateDir };
    const fence = f.run.executorFence;
    if (!fence) {
      throw new Error("Baseline fixture lost its executor.");
    }
    const inspected = await inspectUpdateRecoveryBackup({
      assertOwned: fence.assertCurrent,
      env,
      runId: f.run.runId,
      installRoot: path.join(f.root, "install"),
    });
    expect([...inspected.databaseOwners]).toEqual(
      expect.arrayContaining([
        [resolveOpenClawStateSqlitePath(env), { role: "global" }],
        [
          path.join(resolveAgentDir({}, "main", env), "openclaw-agent.sqlite"),
          {
            role: "agent",
            agentId: "main",
          },
        ],
      ]),
    );
  });
});

it.skipIf(process.platform === "win32")(
  "captures every symlink hop in a retained recovery resource",
  async () => {
    await fixture(async (f) => {
      const ref = await f.capture();
      if (!ref) {
        throw new Error("Baseline fixture did not publish its capture.");
      }
      const verified = await prepareVerifiedBackup(ref);
      let manifest: typeof verified.manifest;
      try {
        manifest = structuredClone(verified.manifest);
      } finally {
        await verified.close();
      }
      const target = path.join(f.stateDir, "retained-chain-target.txt");
      const middle = path.join(f.stateDir, "retained-chain-middle");
      const outer = path.join(f.stateDir, "retained-chain-outer");
      fs.writeFileSync(target, "retained\n", { mode: 0o600 });
      fs.symlinkSync(path.basename(target), middle);
      fs.symlinkSync(path.basename(middle), outer);
      manifest.entries.push(
        {
          kind: "file",
          sourcePath: target,
          archivePath: "payload/retained-chain-target",
          size: 9,
          sha256: "a".repeat(64),
          sqlite: false,
          mode: 0o600,
        },
        {
          kind: "symlink",
          sourcePath: outer,
          target: path.basename(middle),
          contentPath: target,
        },
      );
      const fence = f.run.executorFence;
      if (!fence) {
        throw new Error("Baseline fixture lost its executor.");
      }
      const inspected = await inspectUpdateRecoveryBackup({
        assertOwned: fence.assertCurrent,
        env: f.run.env,
        runId: f.run.runId,
        installRoot: path.join(f.root, "install"),
        baseline: { ref, manifest },
      });
      expect(inspected.manifest.entries).toEqual(
        expect.arrayContaining([
          {
            kind: "symlink",
            sourcePath: outer,
            target: path.basename(middle),
            contentPath: target,
          },
          {
            kind: "symlink",
            sourcePath: middle,
            target: path.basename(target),
            contentPath: target,
          },
        ]),
      );
    });
  },
);

it.skipIf(process.platform === "win32")(
  "retains a dangling ordinary symlink when its captured target was removed",
  async () => {
    await fixture(async (f) => {
      const ref = await f.capture();
      if (!ref) {
        throw new Error("Baseline fixture did not publish its capture.");
      }
      const verified = await prepareVerifiedBackup(ref);
      let manifest: typeof verified.manifest;
      try {
        manifest = structuredClone(verified.manifest);
      } finally {
        await verified.close();
      }
      const target = path.join(f.stateDir, "retired-resource.txt");
      const link = path.join(f.stateDir, "retained-resource-link");
      fs.symlinkSync(path.basename(target), link);
      manifest.entries.push(
        {
          kind: "file",
          sourcePath: target,
          archivePath: "payload/retired-resource",
          size: 1,
          sha256: "a".repeat(64),
          sqlite: false,
          mode: 0o600,
        },
        {
          kind: "symlink",
          sourcePath: link,
          target: path.basename(target),
          contentPath: target,
        },
      );
      const fence = f.run.executorFence;
      if (!fence) {
        throw new Error("Baseline fixture lost its executor.");
      }
      const inspected = await inspectUpdateRecoveryBackup({
        assertOwned: fence.assertCurrent,
        env: f.run.env,
        runId: f.run.runId,
        installRoot: path.join(f.root, "install"),
        baseline: { ref, manifest },
      });
      expect(inspected.manifest.entries).toContainEqual({
        kind: "symlink",
        sourcePath: link,
        target: path.basename(target),
        contentPath: target,
      });
      expect(inspected.manifest.entries).toContainEqual({
        kind: "missing",
        sourcePath: target,
        sqlite: false,
        directory: false,
      });
      const sqliteTarget = path.join(f.stateDir, "retired-plugin.sqlite");
      const sqliteLink = path.join(f.stateDir, "retained-plugin-link.sqlite");
      fs.symlinkSync(path.basename(sqliteTarget), sqliteLink);
      const sqliteManifest = structuredClone(manifest);
      sqliteManifest.entries.push(
        {
          kind: "file",
          sourcePath: sqliteTarget,
          archivePath: "payload/retired-plugin",
          size: 1,
          sha256: "b".repeat(64),
          sqlite: true,
          mode: 0o600,
        },
        {
          kind: "symlink",
          sourcePath: sqliteLink,
          target: path.basename(sqliteTarget),
          contentPath: sqliteTarget,
        },
      );
      await expect(
        inspectUpdateRecoveryBackup({
          assertOwned: fence.assertCurrent,
          env: f.run.env,
          runId: f.run.runId,
          installRoot: path.join(f.root, "install"),
          baseline: { ref, manifest: sqliteManifest },
        }),
      ).rejects.toThrow();
    });
  },
);

it("does not seal or publish a baseline after its original run is substituted", async () => {
  await fixture(async (f) => {
    const originalId = f.run.runId;
    f.run.runId = "substituted";
    try {
      await expect(f.capture()).rejects.toThrow();
      expect(
        getUpdateRun(originalId, { env: f.run.env })?.origin.updateRecoveryCapture,
      ).toBeUndefined();
      expect(fs.existsSync(backupStore(f.stateDir))).toBe(false);
    } finally {
      f.run.runId = originalId;
    }
  });
});

it("retains sealed bytes but refuses the receipt when authority is lost during capture", async () => {
  await fixture(async (f) => {
    const original = f.run.executorFence!;
    const actual = captures.captureUpdateRecoveryBackup;
    let retainedDirectory: string | undefined;
    vi.spyOn(captures, "captureUpdateRecoveryBackup").mockImplementation(async (params) => {
      const ref = await actual(params);
      retainedDirectory = ref.directory;
      f.run.executorFence = {
        ...original,
        assertCurrent() {
          throw new Error("substituted");
        },
      };
      return ref;
    });
    try {
      await expect(f.capture()).rejects.toThrow(
        "Recovery baseline changed its original run or selected state.",
      );
      expect(retainedDirectory).toBeDefined();
      expect(fs.existsSync(path.join(retainedDirectory!, "manifest.json"))).toBe(true);
      expect(
        getUpdateRun(f.run.runId, { env: f.run.env })?.origin.updateRecoveryCapture,
      ).toBeUndefined();
    } finally {
      f.run.executorFence = original;
    }
    acquireStateDatabaseCoordinator({ databasePath: f.statePath, busyTimeoutMs: 0 }).release();
  });
});

it("refuses an installation different from the original selected root before capture", async () => {
  await fixture(async (f) => {
    const other = path.join(f.root, "other-install");
    fs.mkdirSync(other, { mode: 0o700 });
    fs.writeFileSync(path.join(other, "package.json"), '{"name":"openclaw","version":"2.0.0"}');
    await expect(f.capture(other)).rejects.toThrow(
      "effective installation or store selectors diverged",
    );
    expect(
      getUpdateRun(f.run.runId, { env: f.run.env })?.origin.updateRecoveryCapture,
    ).toBeUndefined();
    expect(fs.existsSync(backupStore(f.stateDir))).toBe(false);
  });
});

it("locks a newly introduced nested include before the real baseline capture", async () => {
  await fixture(async (f) => {
    const include = path.join(f.stateDir, "include.json");
    const nested = path.join(f.stateDir, "nested.json");
    const contents = fs.readFileSync(f.configPath, "utf8");
    fs.writeFileSync(include, contents, { mode: 0o600 });
    fs.writeFileSync(f.configPath, JSON.stringify({ $include: "include.json" }));
    const lock = configMutations.withConfigMutationLock;
    const beforeCaptureContext = AsyncLocalStorage.snapshot();
    let changed = false;
    vi.spyOn(configMutations, "withConfigMutationLock").mockImplementation(
      async (params, operation) => {
        if (params.lockPath === include && !changed) {
          changed = true;
          // This cooperating writer wins before capture acquires the include lock.
          // Acknowledge its new closure without timers or an unjoined writer.
          await beforeCaptureContext(() =>
            withConfigWriteLock(include, async () => {
              fs.writeFileSync(nested, contents, { mode: 0o600 });
              fs.writeFileSync(include, JSON.stringify({ $include: "nested.json" }));
            }),
          );
        }
        return lock(params, operation);
      },
    );
    const capture = captures.captureUpdateRecoveryBackup;
    vi.spyOn(captures, "captureUpdateRecoveryBackup").mockImplementation(async (params) => {
      const guard = captureConfigWriteLockGuard(nested);
      expect(guard).toBeTypeOf("function");
      guard!();
      return capture(params);
    });
    const ref = await f.capture();
    expect(changed).toBe(true);
    const verified = await prepareVerifiedBackup(ref!);
    try {
      expect(verified.manifest.configPaths).toContain(nested);
      const entry = verified.manifest.entries.find((item) => item.sourcePath === nested);
      if (entry?.kind !== "file") {
        throw new Error("Nested acknowledged config is missing");
      }
      expect(fs.readFileSync(verified.payloads.get(entry.archivePath)!, "utf8")).toBe(contents);
    } finally {
      await verified.close();
    }
  });
});

it("persists exact accepted root and include writer receipts on the original baseline row", async () => {
  await fixture(async (f) => {
    const include = path.join(f.stateDir, "logging.json");
    const initial = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
    fs.writeFileSync(include, JSON.stringify({ level: "info" }), { mode: 0o600 });
    fs.writeFileSync(
      f.configPath,
      JSON.stringify({ ...initial, logging: { $include: "logging.json" } }),
    );
    const beforeRoot = fs.readFileSync(f.configPath, "utf8");
    const beforeInclude = fs.readFileSync(include, "utf8");
    const baseline = await f.capture();
    await configMutations.mutateConfigFile({
      mutate: (draft) => {
        draft.update = { channel: "dev" };
      },
    });
    const afterRoot = fs.readFileSync(f.configPath, "utf8");
    await configMutations.mutateConfigFile({
      mutate: (draft) => {
        draft.logging = { level: "debug" };
      },
    });
    const afterInclude = fs.readFileSync(include, "utf8");
    expect(afterRoot).not.toBe(beforeRoot);
    expect(afterInclude).not.toBe(beforeInclude);
    expect(fs.readFileSync(f.configPath, "utf8")).toBe(afterRoot);
    await persistOriginalUpdateConfigWrites(f.run);
    const receipt = getUpdateRun(f.run.runId, { env: f.run.env })?.origin.updateRecoveryCapture;
    expect(receipt?.manifestSha256).toBe(baseline!.manifestSha256);
    expect(receipt?.configWrites).toEqual(
      [
        {
          path: include,
          beforeHash: hashConfigRaw(beforeInclude),
          afterHash: hashConfigRaw(afterInclude),
          contiguous: true,
        },
        {
          path: f.configPath,
          beforeHash: hashConfigRaw(beforeRoot),
          afterHash: hashConfigRaw(afterRoot),
          contiguous: true,
        },
      ].toSorted((a, b) => a.path.localeCompare(b.path)),
    );
  });
});

it("records a discontinuity across an intervening external config write without losing newer bytes", async () => {
  await fixture(async (f) => {
    const before = fs.readFileSync(f.configPath, "utf8");
    await f.capture();
    await configMutations.mutateConfigFile({
      mutate: (draft) => {
        draft.update = { channel: "dev" };
      },
    });
    await persistOriginalUpdateConfigWrites(f.run);
    const external = {
      ...JSON.parse(fs.readFileSync(f.configPath, "utf8")),
      logging: { level: "warn" },
    };
    fs.writeFileSync(f.configPath, JSON.stringify(external));
    await configMutations.mutateConfigFile({
      mutate: (draft) => {
        draft.update = { channel: "beta" };
      },
    });
    const after = fs.readFileSync(f.configPath, "utf8");
    await persistOriginalUpdateConfigWrites(f.run);
    expect(JSON.parse(after).logging.level).toBe("warn");
    expect(
      getUpdateRun(f.run.runId, { env: f.run.env })?.origin.updateRecoveryCapture?.configWrites,
    ).toEqual([
      {
        path: f.configPath,
        beforeHash: hashConfigRaw(before),
        afterHash: hashConfigRaw(after),
        contiguous: false,
      },
    ]);
  });
});

it.each(["root", "include"] as const)(
  "does not publish an accepted %s receipt after runtime compensation",
  async (kind) => {
    await fixture(async (f) => {
      const include = path.join(f.stateDir, "logging.json");
      if (kind === "include") {
        const initial = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
        fs.writeFileSync(include, JSON.stringify({ level: "info" }), { mode: 0o600 });
        fs.writeFileSync(
          f.configPath,
          JSON.stringify({ ...initial, logging: { $include: "logging.json" } }),
        );
      }
      const target = kind === "include" ? include : f.configPath;
      const before = fs.readFileSync(target, "utf8");
      await f.capture();
      setRuntimeConfigSnapshotRefreshHandler({
        preflight: () => true,
        refresh: () => {
          throw new Error("receipt refresh failure");
        },
      });
      try {
        await expect(
          configMutations.mutateConfigFile({
            mutate: (draft) => {
              draft.logging = { level: "debug" };
            },
          }),
        ).rejects.toMatchObject({
          name: "ConfigWritePostCommitError",
          rollbackStatus: "restored",
        });
      } finally {
        setRuntimeConfigSnapshotRefreshHandler(null);
      }
      expect(fs.readFileSync(target, "utf8")).toBe(before);
      await persistOriginalUpdateConfigWrites(f.run);
      expect(
        getUpdateRun(f.run.runId, { env: f.run.env })?.origin.updateRecoveryCapture?.configWrites,
      ).toEqual([]);
    });
  },
);
