import syncFs from "node:fs";
import fs from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as postCoreConvergence from "../../commands/doctor/shared/post-core-plugin-convergence.js";
import * as config from "../../config/config.js";
import { CONFIG_AUDIT_SCOPE } from "../../config/io.audit.js";
import * as configFactory from "../../config/io.factory.js";
import { createConfigIO } from "../../config/io.js";
import { replaceConfigFile } from "../../config/mutate.js";
import { captureConfigWriteLockGuard, withConfigWriteLock } from "../../config/write-lock.js";
import * as gatewayEntrypoint from "../../daemon/gateway-entrypoint.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
  type DeferredPluginMigration,
} from "../../infra/deferred-plugin-migrations.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import {
  POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV,
  POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV,
  POST_CORE_UPDATE_RESULT_PATH_ENV,
  POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
  POST_CORE_UPDATE_STARTED_AT_ENV,
} from "../../infra/update-post-core-context.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import * as pluginBridges from "../../plugins/location-bridges.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import * as pluginRegistryRefresh from "../../plugins/registry-refresh.js";
import * as updateCohort from "../../plugins/update-cohort.js";
import * as commandExec from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { pluginSyncResult, postCoreConvergenceResult } from "./update-cli-config.test-support.js";
import {
  persistRequestedUpdateChannel,
  persistValidatedDowngradeConfig,
  preparePostCorePluginConfig,
  readUpdateChannelConfig,
} from "./update-command-config.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import * as freshDoctor from "./update-command-fresh-doctor.js";
import { createPostCorePluginUpdateResult } from "./update-command-plugins-internals.js";
import * as updatePlugins from "./update-command-plugins.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

const dirs = createTempDirTracker();
let home: string, stateDir: string, configPath: string, root: string, control: string;
let fixtureEnv: NodeJS.ProcessEnv;
beforeEach(async () => {
  home = await fs.realpath(dirs.make("update-config-fence-"));
  stateDir = path.join(home, "state");
  configPath = path.join(stateDir, "openclaw.json");
  root = path.join(home, "package");
  control = path.join(home, "control");
  for (const dir of [stateDir, root, control]) {
    await fs.mkdir(dir);
  }
  fixtureEnv = {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  dirs.cleanup();
});

function stubEnv(env: NodeJS.ProcessEnv) {
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
}

function revokeExecutor(controlDir: string, installRoot: string) {
  const db = openNodeSqliteDatabase(path.join(controlDir, "managed-update-handoffs.sqlite"));
  try {
    db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
      "replacement",
      installRoot,
    );
  } finally {
    db.close();
  }
}

it("preserves deferred Canvas inputs through update preparation and a channel write", async () => {
  stubEnv(fixtureEnv);
  const canvasHost = { root: "/retained/canvas-documents" };
  const authored = { gateway: { mode: "local" }, update: { channel: "stable" }, canvasHost };
  const original = JSON.stringify(authored);
  await fs.writeFile(configPath, original);
  const pending: DeferredPluginMigration = {
    pluginId: "canvas",
    reason: "Canvas document migration is unfinished.",
    command: "openclaw doctor --fix",
    requiresStateMigration: true,
    configPaths: [["canvasHost"]],
    validationExcludedPaths: [["canvasHost"]],
  };
  await recordDeferredPluginMigrations({ pending: [pending] });
  await closeOpenClawStateDatabaseAsync();

  const before = await readUpdateChannelConfig(false);
  expect(before).toMatchObject({ configSnapshot: { valid: true }, storedChannel: "stable" });
  expect(await fs.readFile(configPath, "utf8")).toBe(original);
  const prepared = await preparePostCorePluginConfig({
    requestedChannel: "beta",
    observe: false,
  });

  expect(prepared.configSnapshot.valid).toBe(true);
  expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
    canvasHost,
    update: { channel: "beta" },
  });
  expect(readDeferredPluginMigrations()).toEqual([pending]);
  expect((await config.readConfigFileSnapshot({ observe: false })).valid).toBe(false);
});

it("retains the stored channel during tolerant invalid config reads without rewriting source", async () => {
  stubEnv(fixtureEnv);
  const channel = "beta";
  const original = `{\n  // Keep the authored channel while another field needs repair.\n  update: { channel: '${channel}' },\n  gateway: { port: 'invalid' },\n}\n`;
  await fs.writeFile(configPath, original);
  const ordinary = await readUpdateChannelConfig(false);
  expect(ordinary).toMatchObject({ configSnapshot: { valid: false }, storedChannel: null });

  const tolerant = await readUpdateChannelConfig(false, { tolerateReadFailure: true });
  expect(tolerant).toMatchObject({ configSnapshot: { valid: false }, storedChannel: channel });
  expect(await fs.readFile(configPath, "utf8")).toBe(original);
  expect(await fs.readdir(stateDir)).toEqual(["openclaw.json"]);
});

it.each([
  { flow: "prepare", suspicious: false },
  { flow: "prepare", suspicious: true },
  { flow: "channel", suspicious: true },
  { flow: "downgrade", suspicious: true },
  { flow: "plugins", suspicious: true },
  { flow: "candidate-prepare", suspicious: true },
  { flow: "candidate-commit", suspicious: true },
  { flow: "fresh-check", suspicious: true },
] as const)(
  "preserves config observation state after $flow executor revocation (suspicious=$suspicious)",
  async ({ flow, suspicious }) => {
    stubEnv(fixtureEnv);
    vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const preparationFlow = flow === "prepare" || flow === "candidate-prepare";
    const candidateFlow = flow === "candidate-prepare" || flow === "candidate-commit";
    const commitFlow = flow === "candidate-commit";
    const freshCheckFlow = flow === "fresh-check";
    await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","version":"1.0.0"}\n');
    if (flow === "prepare") {
      // Exercise modern parent-owned completion before the config preparation boundary.
      await fs.writeFile(path.join(home, "handoff.json"), '{"completionOwner":"parent"}\n');
    }
    stubEnv({
      OPENCLAW_CONFIG_READONLY: undefined,
      OPENCLAW_NIX_MODE: undefined,
      OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
      [POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV]: undefined,
      [POST_CORE_UPDATE_STARTED_AT_ENV]: String(Date.now()),
      [POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV]: undefined,
      [POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV]: undefined,
      [POST_CORE_UPDATE_RESULT_PATH_ENV]:
        flow === "prepare" ? path.join(home, "post-core-result.json") : undefined,
    });
    const env = { ...process.env };
    const run = createUpdateRun({ trigger: "cli" }, { env });
    const original = {
      meta: { lastTouchedVersion: "2026.4.22" },
      gateway: { mode: "local", port: 18789 },
    };
    await fs.writeFile(configPath, JSON.stringify(original));
    const io = createConfigIO({ env, configPath, pluginValidation: "skip" });
    expect((await io.readConfigFileSnapshot()).valid).toBe(true);
    const candidate = JSON.stringify({
      ...(suspicious
        ? { update: { channel: "beta" } }
        : { ...original, gateway: { ...original.gateway, port: 18791 } }),
      ...(flow === "downgrade" ? { meta: { lastTouchedVersion: "9999.0.0" } } : {}),
    });
    await fs.writeFile(configPath, candidate);
    const prepared = await createConfigIO({
      env,
      configPath,
      pluginValidation: "skip",
      observe: false,
      suppressFutureVersionWarning: true,
    }).readConfigFileSnapshotForWrite();
    expect(prepared.snapshot.valid).toBe(true);
    const observations = () =>
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => {
          const queries =
            getNodeSqliteKysely<
              Pick<OpenClawStateDatabase, "config_health_entries" | "diagnostic_events">
            >(db);
          return {
            health: executeSqliteQuerySync(
              db,
              queries.selectFrom("config_health_entries").selectAll().orderBy("config_path"),
            ).rows,
            audit: executeSqliteQuerySync(
              db,
              queries
                .selectFrom("diagnostic_events")
                .selectAll()
                .where("scope", "=", CONFIG_AUDIT_SCOPE)
                .orderBy("sequence"),
            ).rows,
          };
        },
        { env },
      );
    const before = observations();
    expect(before?.health).toHaveLength(1);
    expect(before?.audit).toEqual([]);
    const plugins =
      preparationFlow || candidateFlow
        ? vi
            .spyOn(updatePlugins, "updatePluginsAfterCoreUpdate")
            .mockRejectedValue(new Error("Unexpected plugin convergence after ownership loss"))
        : undefined;
    const refresh = vi
      .spyOn(pluginRegistryRefresh, "refreshPluginRegistryAfterConfigMutation")
      .mockRejectedValue(new Error("Unexpected registry refresh after ownership loss"));
    if (flow === "plugins") {
      vi.spyOn(pluginBridges, "listPersistedBundledPluginLocationBridges").mockResolvedValue([]);
      vi.spyOn(updateCohort, "convergePluginReleaseCohort").mockImplementation(
        async ({ config: pluginConfig }) => ({
          config: pluginConfig,
          changed: false,
          npmChanged: false,
          sync: pluginSyncResult(pluginConfig),
          missingPayloads: [],
          remainingMissingPayloads: [],
          repairedMissingPayloadIds: new Set<string>(),
          repairOutcomes: [],
          updateOutcomes: [],
        }),
      );
      vi.spyOn(postCoreConvergence, "runPostCorePluginConvergence").mockImplementation(
        async ({ cfg: pluginConfig }) => ({
          ...postCoreConvergenceResult(),
          config: pluginConfig,
        }),
      );
    }
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw new Error("Unexpected post-core completion after ownership loss");
    });
    let preparedBeforeRevocation = false;
    let mutationActive = false;
    const revoke = () => {
      preparedBeforeRevocation = true;
      const lockGuard = captureConfigWriteLockGuard(configPath);
      revokeExecutor(control, root);
      if (!preparationFlow && !freshCheckFlow) {
        expect(lockGuard).toBeTypeOf("function");
        expect(lockGuard).toThrow(/executor|ownership/i);
      }
    };
    const duringMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
      mutationActive = true;
      try {
        return await operation();
      } finally {
        mutationActive = false;
      }
    };
    const mutate = config.mutateConfigFileWithRetry;
    const replace = config.replaceConfigFile;
    const mutationBoundary =
      flow === "plugins"
        ? vi
            .spyOn(config, "replaceConfigFile")
            .mockImplementation((params) => duringMutation(() => replace(params)))
        : preparationFlow
          ? undefined
          : vi.spyOn(config, "mutateConfigFileWithRetry").mockImplementation((params) => {
              const writeOptions = params.writeOptions;
              let mutation = params;
              if (commitFlow) {
                mutation = {
                  ...params,
                  writeOptions: {
                    ...writeOptions,
                    beforeCommit: async () => {
                      await writeOptions?.beforeCommit?.();
                      revoke();
                    },
                  },
                };
              }
              return duringMutation(() => mutate(mutation));
            });
    const factoryModule = preparationFlow ? config : configFactory;
    const realCreateConfigIO = factoryModule.createConfigIO;
    const factory = vi.spyOn(factoryModule, "createConfigIO").mockImplementation((options) =>
      realCreateConfigIO({
        ...options,
        // Keep the real reader and observer; revoke after snapshot preparation,
        // immediately before observation and the caller's next fence assertion.
        measure: async (name, operation) => {
          const result = await operation();
          if (
            name === "config.snapshot.read.materialize" &&
            !preparedBeforeRevocation &&
            !commitFlow &&
            (preparationFlow || mutationActive)
          ) {
            revoke();
          }
          return result;
        },
      }),
    );
    if (freshCheckFlow) {
      vi.spyOn(gatewayEntrypoint, "resolveGatewayInstallEntrypoint").mockResolvedValue(
        path.join(root, "dist", "index.js"),
      );
      vi.spyOn(commandExec, "runExec").mockImplementation(async (_command, args) => {
        if (args.includes("validate")) {
          await fs.stat(configPath);
          revoke();
          return { stdout: "", stderr: "" };
        }
        expect(args).toContain("--lint");
        return {
          stdout: JSON.stringify({ ok: true, checksRun: 1, findings: [] }),
          stderr: "",
        };
      });
    }
    await expect(
      withUpdateCommandExecutor(run.runId, async (executor) => {
        const executorFence = await executor.enter(root);
        if (candidateFlow) {
          const result = resultFixture(root, {
            before: { version: "2.0.0" },
            after: { version: "1.0.0" },
          });
          await convergeUpdatePlugins({
            candidateRuntime: candidateFlow,
            root,
            result,
            configSnapshot: prepared.snapshot,
            requestedChannel: commitFlow ? (suspicious ? "stable" : "beta") : null,
            storedChannel: suspicious ? "beta" : null,
            channel: "stable",
            installKindChanged: false,
            downgradeRisk: false,
            opts: { json: true, run: { runId: run.runId, env, executorFence } },
            preUpdatePluginInstallRecords: {},
            startedAt: Date.now(),
            updateStepTimeoutMs: 1_000,
          });
        } else if (freshCheckFlow) {
          await freshDoctor.completePostCorePluginUpdate({
            root,
            pluginUpdate: createPostCorePluginUpdateResult({ status: "ok" }),
            yes: true,
            json: true,
            timeoutMs: 1_000,
          });
          executorFence.assertCurrent();
        } else if (flow === "prepare") {
          await resumePostCoreUpdate({
            root,
            channel: "stable",
            opts: { json: true, run: { runId: run.runId, env, executorFence } },
            timeoutMs: 1_000,
          });
        } else if (flow === "channel") {
          await persistRequestedUpdateChannel({
            configSnapshot: prepared.snapshot,
            requestedChannel: suspicious ? "stable" : "beta",
            assertCurrent: executorFence.assertCurrent,
          });
        } else if (flow === "downgrade") {
          await persistValidatedDowngradeConfig(prepared.snapshot, executorFence.assertCurrent);
        } else {
          await withPluginLifecycleLease({ assertCurrent: executorFence.assertCurrent }, () =>
            updatePlugins.updatePluginsAfterCoreUpdate({
              root,
              channel: "stable",
              configSnapshot: prepared.snapshot,
              configWriteOptions: prepared.writeOptions,
              configChanged: true,
              pluginInstallRecords: {},
              json: true,
              timeoutMs: 1_000,
              assertCurrent: executorFence.assertCurrent,
            }),
          );
        }
      }),
    ).rejects.toThrow(/executor|ownership|release/i);
    expect(preparedBeforeRevocation).toBe(true);
    if (plugins) {
      expect(plugins).not.toHaveBeenCalled();
    }
    expect(refresh).not.toHaveBeenCalled();
    expect(observations()).toEqual(before);
    expect(await fs.readFile(configPath, "utf8")).toBe(candidate);

    // The update-only fence policy must not disable ordinary config observation.
    factory.mockRestore();
    mutationBoundary?.mockRestore();
    if (preparationFlow) {
      const ordinary = await preparePostCorePluginConfig({ requestedChannel: null });
      expect(ordinary.configSnapshot.valid).toBe(true);
    } else {
      const stopAfterRead = new Error("Stop ordinary mutation after its observed read");
      await expect(
        config.mutateConfigFileWithRetry({
          mutate: () => {
            throw stopAfterRead;
          },
        }),
      ).rejects.toBe(stopAfterRead);
    }
    const observed = observations();
    expect(observed?.health).not.toEqual(before?.health);
    if (suspicious) {
      expect(observed?.audit).toHaveLength(1);
      expect(JSON.parse(observed!.audit[0]!.payload_json)).toMatchObject({
        event: "config.observe",
        configPath,
        suspicious: expect.arrayContaining(["gateway-mode-missing-vs-last-good"]),
      });
    } else {
      expect(observed?.audit).toEqual(before?.audit);
    }
  },
);

it.each([
  { revoked: false, included: false, late: false },
  { revoked: true, included: false, late: false },
  { revoked: false, included: true, late: false },
  { revoked: true, included: true, late: false },
  { revoked: true, included: true, late: true },
])(
  "guards config publication with its live source executor (revoked=$revoked, included=$included, late=$late)",
  async ({ revoked, included, late }) => {
    vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const env = { ...process.env, ...fixtureEnv };
    const run = createUpdateRun({ trigger: "cli" }, { env });
    const includePath = path.join(stateDir, "includes", "gateway.json");
    const includedRaw = '{"mode":"local","port":18789}\n';
    const original = included
      ? '{"gateway":{"$include":"./includes/gateway.json"}}\n'
      : '{"gateway":{"mode":"local","port":18789}}\n';
    await fs.writeFile(configPath, original);
    if (included) {
      await fs.mkdir(path.dirname(includePath));
      if (process.platform !== "win32") {
        await fs.chown(path.dirname(includePath), -1, userInfo().gid);
        await fs.chmod(path.dirname(includePath), 0o3700);
        expect((await fs.stat(path.dirname(includePath))).mode & 0o7777).toBe(0o3700);
      }
      await fs.writeFile(includePath, includedRaw);
    }
    const preservedPaths = included ? [configPath, includePath] : [];
    if (included) {
      for (const target of [configPath, includePath]) {
        for (const suffix of [".bak", ".bak.1"]) {
          const backupPath = `${target}${suffix}`;
          await fs.writeFile(backupPath, `retained ${path.basename(backupPath)}\n`);
          preservedPaths.push(backupPath);
        }
      }
    }
    const captureFiles = () =>
      Promise.all(
        preservedPaths.map(async (target) => {
          const { dev, ino, mode, mtimeNs, ctimeNs } = await fs.lstat(target, { bigint: true });
          return {
            bytes: await fs.readFile(target),
            dev,
            ino,
            mode,
            mtimeNs,
            ctimeNs,
          };
        }),
      );
    const beforeFiles = await captureFiles();
    const beforeEntries = included
      ? [await fs.readdir(stateDir), await fs.readdir(path.dirname(includePath))]
      : [];
    let reachedCommit = false;
    let revokedDuringSync = false;
    const owned = withUpdateCommandExecutor(run.runId, async (executor) => {
      const fence = await executor.enter(home);
      const revoke = () => revokeExecutor(control, home);
      if (late) {
        const fsync = syncFs.fsyncSync;
        vi.spyOn(syncFs, "fsyncSync").mockImplementation((fd) => {
          fsync(fd);
          if (reachedCommit && !revokedDuringSync) {
            revoke();
            revokedDuringSync = true;
          }
        });
      }
      const io = createConfigIO({ configPath, env, observe: false, pluginValidation: "skip" });
      const beforeCommit = async () => {
        reachedCommit = true;
        if (revoked && !late) {
          revoke();
        }
      };
      const locked = <T>(target: string, operation: () => Promise<T>) =>
        withConfigWriteLock(target, operation, env, () => fence.assertCurrent());
      return locked(configPath, () =>
        locked(includePath, async () => {
          const nextConfig = { gateway: { mode: "local" as const, port: 18791 } };
          if (!included) {
            return io.writeConfigFile(nextConfig, { beforeCommit });
          }
          const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
          return replaceConfigFile({
            snapshot,
            baseHash: snapshot.hash,
            nextConfig: {
              ...snapshot.sourceConfig,
              gateway: { ...snapshot.sourceConfig.gateway, port: 18791 },
            },
            writeOptions: { ...writeOptions, beforeCommit, skipPluginValidation: true },
            io: { ...io, env },
          });
        }),
      );
    });
    if (revoked) {
      await expect(owned).rejects.toThrow(/executor|ownership/i);
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      if (included) {
        expect(await captureFiles()).toEqual(beforeFiles);
        expect([await fs.readdir(stateDir), await fs.readdir(path.dirname(includePath))]).toEqual(
          beforeEntries,
        );
      }
    } else {
      await owned;
      expect(
        JSON.parse(await fs.readFile(included ? includePath : configPath, "utf8")).gateway?.port ??
          JSON.parse(await fs.readFile(includePath, "utf8")).port,
      ).toBe(18791);
      if (included) {
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        expect(await fs.readFile(`${includePath}.bak`, "utf8")).toBe(includedRaw);
      }
    }
    expect(reachedCommit).toBe(true);
    expect(revokedDuringSync).toBe(late);
    if (included && process.platform !== "win32") {
      expect((await fs.stat(path.dirname(includePath))).mode & 0o7777).toBe(0o3700);
    }
  },
);
