import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as postCoreConvergence from "../../commands/doctor/shared/post-core-plugin-convergence.js";
import * as config from "../../config/config.js";
import { CONFIG_AUDIT_SCOPE } from "../../config/io.audit.js";
import * as configFactory from "../../config/io.factory.js";
import { createConfigIO } from "../../config/io.js";
import { replaceConfigFile } from "../../config/mutate.js";
import { GUARDED_CONFIG_INCLUDE_WRITE_ERROR } from "../../config/mutation-conflict.js";
import { captureConfigWriteLockGuard, withConfigWriteLock } from "../../config/write-lock.js";
import * as gatewayEntrypoint from "../../daemon/gateway-entrypoint.js";
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
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import * as pluginRegistryRefresh from "../../plugins/registry-refresh.js";
import * as updateCohort from "../../plugins/update-cohort.js";
import * as commandExec from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateDatabase } from "../../state/openclaw-state-db.generated.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as pluginBridges from "../plugins-location-bridges.js";
import {
  persistRequestedUpdateChannel,
  persistValidatedDowngradeConfig,
  preparePostCorePluginConfig,
} from "./update-command-config.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import * as freshDoctor from "./update-command-fresh-doctor.js";
import * as updatePlugins from "./update-command-plugins.js";
import * as postCore from "./update-command-post-core.js";
import { shouldResumePostCoreUpdateInFreshProcess } from "./update-command-post-core.js";
import * as postCoreResume from "./update-command-resume.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each(
  (
    [
      "prepare",
      "channel",
      "downgrade",
      "plugins",
      "candidate-prepare",
      "candidate-commit",
      "ordinary-prepare",
      "ordinary-commit",
      "fresh-check",
    ] as const
  ).flatMap((flow) => [false, true].map((suspicious) => ({ flow, suspicious }))),
)(
  "preserves config observation state after $flow executor revocation (suspicious=$suspicious)",
  async ({ flow, suspicious }) => {
    const preparationFlow =
      flow === "prepare" || flow === "candidate-prepare" || flow === "ordinary-prepare";
    const candidateFlow = flow === "candidate-prepare" || flow === "candidate-commit";
    const ordinaryFlow = flow === "ordinary-prepare" || flow === "ordinary-commit";
    const commitFlow = flow === "candidate-commit" || flow === "ordinary-commit";
    const freshCheckFlow = flow === "fresh-check";
    const home = await fs.realpath(dirs.make("update-config-observation-fence-"));
    const stateDir = path.join(home, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const root = path.join(home, "package");
    const control = path.join(home, "control");
    await fs.mkdir(root);
    await fs.mkdir(control);
    await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","version":"1.0.0"}\n');
    vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    await withEnvAsync(
      {
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_HOME: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_CONFIG_READONLY: undefined,
        OPENCLAW_NIX_MODE: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
        [POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV]: undefined,
        [POST_CORE_UPDATE_STARTED_AT_ENV]: String(Date.now()),
        [POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV]: undefined,
        [POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV]: undefined,
        [POST_CORE_UPDATE_RESULT_PATH_ENV]: undefined,
      },
      async () => {
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
          preparationFlow || candidateFlow || ordinaryFlow
            ? vi
                .spyOn(updatePlugins, "updatePluginsAfterCoreUpdate")
                .mockRejectedValue(new Error("Unexpected plugin convergence after ownership loss"))
            : undefined;
        const refresh = vi
          .spyOn(pluginRegistryRefresh, "refreshPluginRegistryAfterConfigMutation")
          .mockRejectedValue(new Error("Unexpected registry refresh after ownership loss"));
        if (flow === "plugins") {
          vi.spyOn(pluginBridges, "listPersistedBundledPluginLocationBridges").mockResolvedValue(
            [],
          );
          vi.spyOn(updateCohort, "convergePluginReleaseCohort").mockImplementation(
            async ({ config: pluginConfig }) => ({
              config: pluginConfig,
              changed: false,
              npmChanged: false,
              sync: {
                config: pluginConfig,
                changed: false,
                summary: {
                  errors: [],
                  warnings: [],
                  switchedToBundled: [],
                  switchedToClawHub: [],
                  switchedToNpm: [],
                },
              },
              missingPayloads: [],
              remainingMissingPayloads: [],
              repairedMissingPayloadIds: new Set<string>(),
              repairOutcomes: [],
              updateOutcomes: [],
            }),
          );
          vi.spyOn(postCoreConvergence, "runPostCorePluginConvergence").mockResolvedValue({
            changes: [],
            warnings: [],
            installRecords: {},
            errored: false,
            smokeFailures: [],
          });
        }
        vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
          throw new Error("Unexpected post-core completion after ownership loss");
        });
        let preparedBeforeRevocation = false;
        let mutationLockRejected = false;
        let mutationActive = false;
        const revoke = () => {
          preparedBeforeRevocation = true;
          const lockGuard = captureConfigWriteLockGuard(configPath);
          const db = openNodeSqliteDatabase(path.join(control, "managed-update-handoffs.sqlite"));
          try {
            db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
              "replacement",
              root,
            );
          } finally {
            db.close();
          }
          if (!preparationFlow && !freshCheckFlow) {
            expect(lockGuard).toBeTypeOf("function");
            expect(lockGuard).toThrow(/executor|ownership/i);
            mutationLockRejected = true;
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
              : vi.spyOn(config, "mutateConfigFileWithRetry").mockImplementation((params) =>
                  duringMutation(() =>
                    mutate(
                      commitFlow
                        ? {
                            ...params,
                            writeOptions: {
                              ...params.writeOptions,
                              beforeCommit: async () => {
                                await params.writeOptions?.beforeCommit?.();
                                revoke();
                              },
                            },
                          }
                        : params,
                    ),
                  ),
                );
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
            if (candidateFlow || ordinaryFlow) {
              const result = {
                status: "ok" as const,
                mode: "npm" as const,
                root,
                before: { version: "2.0.0" },
                after: { version: "1.0.0" },
                steps: [],
                durationMs: 0,
              };
              if (ordinaryFlow) {
                // Old targets below the post-core writer floor retain the original runtime.
                expect(
                  shouldResumePostCoreUpdateInFreshProcess({ result, downgradeRisk: true }),
                ).toBe(false);
              }
              await convergeUpdatePlugins({
                candidateRuntime: candidateFlow,
                root,
                result,
                configSnapshot: prepared.snapshot,
                requestedChannel: commitFlow ? (suspicious ? "stable" : "beta") : null,
                storedChannel: suspicious ? "beta" : null,
                channel: "stable",
                installKindChanged: false,
                downgradeRisk: ordinaryFlow,
                opts: { json: true, run: { runId: run.runId, env, executorFence } },
                preUpdatePluginInstallRecords: {},
                startedAt: Date.now(),
                updateStepTimeoutMs: 1_000,
              });
            } else if (freshCheckFlow) {
              await freshDoctor.completePostCorePluginUpdate({
                root,
                pluginUpdate: {
                  status: "ok",
                  changed: false,
                  sync: {
                    changed: false,
                    switchedToBundled: [],
                    switchedToNpm: [],
                    warnings: [],
                    errors: [],
                  },
                  npm: { changed: false, outcomes: [] },
                  integrityDrifts: [],
                },
                freshDoctorRequired: false,
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
        if (!preparationFlow && !freshCheckFlow) {
          expect(mutationLockRejected).toBe(true);
        }
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
  },
);

it("converges healthy candidate code once without nested delegation and restores its host context", async () => {
  const home = await fs.realpath(dirs.make("update-candidate-convergence-"));
  const configPath = path.join(home, "openclaw.json");
  const root = path.join(home, "package");
  const control = path.join(home, "control");
  await fs.mkdir(root);
  await fs.mkdir(control);
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","version":"1.0.0"}\n');
  await fs.writeFile(configPath, '{"gateway":{"mode":"local","port":18789}}\n');
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  await withEnvAsync(
    {
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_STATE_DIR: home,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_HOME: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_CONFIG_READONLY: undefined,
      OPENCLAW_NIX_MODE: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_COMPATIBILITY_HOST_VERSION: "9.0.0",
    },
    async () => {
      const configSnapshot = await createConfigIO({
        configPath,
        observe: false,
        pluginValidation: "skip",
      }).readConfigFileSnapshot();
      expect(configSnapshot.valid).toBe(true);
      const pluginUpdate: updatePlugins.PostCorePluginUpdateResult = {
        status: "ok",
        changed: false,
        sync: {
          changed: false,
          switchedToBundled: [],
          switchedToNpm: [],
          warnings: [],
          errors: [],
        },
        npm: { changed: false, outcomes: [] },
        integrityDrifts: [],
      };
      const plugins = vi
        .spyOn(updatePlugins, "updatePluginsAfterCoreUpdate")
        .mockImplementation(async ({ assertCurrent }) => {
          assertCurrent?.();
          expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("1.0.0");
          return pluginUpdate;
        });
      const phase = vi.spyOn(postCoreResume, "convergePostCoreUpdatePlugins");
      const delegate = vi
        .spyOn(postCore, "continuePostCoreUpdateInFreshProcess")
        .mockRejectedValue(new Error("Candidate code must not delegate its shared phase again"));
      vi.spyOn(freshDoctor, "completePostCorePluginUpdate").mockResolvedValue({
        pluginUpdate,
        configSnapshot,
      });
      const result = {
        status: "ok" as const,
        mode: "npm" as const,
        root,
        before: { version: "2.0.0" },
        after: { version: "1.0.0" },
        steps: [],
        durationMs: 0,
      };
      expect(shouldResumePostCoreUpdateInFreshProcess({ result, downgradeRisk: false })).toBe(true);
      const env = { ...process.env };
      const run = createUpdateRun({ trigger: "cli" }, { env });
      await withUpdateCommandExecutor(run.runId, async (executor) => {
        const executorFence = await executor.enter(root);
        const assertCurrent = vi.fn(() => executorFence.assertCurrent());
        const completed = await convergeUpdatePlugins({
          candidateRuntime: true,
          result,
          root,
          installKindChanged: false,
          configSnapshot,
          requestedChannel: null,
          storedChannel: null,
          channel: "stable",
          downgradeRisk: false,
          opts: { json: true, run: { runId: run.runId, env, executorFence } },
          preUpdatePluginInstallRecords: {},
          startedAt: Date.now(),
          updateStepTimeoutMs: 1_000,
          assertCurrent,
        });
        expect(completed.resultWithPostUpdate.status).toBe("ok");
        expect(completed.resultWithPostUpdate.postUpdate?.plugins).toBe(pluginUpdate);
        expect(assertCurrent).toHaveBeenCalled();
        expect(phase).toHaveBeenCalledWith(expect.objectContaining({ assertCurrent }));
        expect(plugins).toHaveBeenCalledWith(expect.objectContaining({ assertCurrent }));
      });
      expect(phase).toHaveBeenCalledTimes(1);
      expect(plugins).toHaveBeenCalledTimes(1);
      expect(delegate).not.toHaveBeenCalled();
      expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("9.0.0");
    },
  );
});

it.each([
  { revoked: false, included: false, late: false },
  { revoked: true, included: false, late: false },
  { revoked: false, included: true, late: false },
  { revoked: true, included: true, late: false },
  { revoked: true, included: true, late: true },
])(
  "guards config publication with its live source executor (revoked=$revoked, included=$included, late=$late)",
  async ({ revoked, included, late }) => {
    const home = await fs.realpath(dirs.make("update-config-commit-fence-"));
    const stateDir = path.join(home, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const control = path.join(home, "control");
    await fs.mkdir(control);
    vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_HOME: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const options = { env };
    const run = createUpdateRun({ trigger: "cli" }, options);
    const includePath = path.join(stateDir, "includes", "gateway.json");
    const includedRaw = '{"mode":"local","port":18789}\n';
    const original = included
      ? '{"gateway":{"$include":"./includes/gateway.json"}}\n'
      : '{"gateway":{"mode":"local","port":18789}}\n';
    await fs.writeFile(configPath, original);
    if (included) {
      await fs.mkdir(path.dirname(includePath));
      if (process.platform !== "win32") {
        await fs.chmod(path.dirname(includePath), 0o3700);
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
          const stat = await fs.lstat(target, { bigint: true });
          return {
            bytes: await fs.readFile(target),
            dev: stat.dev,
            ino: stat.ino,
            mode: stat.mode,
            mtimeNs: stat.mtimeNs,
            ctimeNs: stat.ctimeNs,
          };
        }),
      );
    const beforeFiles = await captureFiles();
    const beforeEntries = included
      ? [await fs.readdir(stateDir), await fs.readdir(path.dirname(includePath))]
      : [];
    let reachedCommit = false;
    const owned = withUpdateCommandExecutor(run.runId, async (executor) => {
      const fence = await executor.enter(home);
      const io = createConfigIO({ configPath, env, observe: false, pluginValidation: "skip" });
      const revoke = () => {
        const db = openNodeSqliteDatabase(path.join(control, "managed-update-handoffs.sqlite"));
        try {
          db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
            "replacement",
            home,
          );
        } finally {
          db.close();
        }
      };
      const beforeCommit = async () => {
        reachedCommit = true;
        if (revoked && !late) {
          revoke();
        }
        if (late) {
          const fsync = syncFs.fsyncSync;
          vi.spyOn(syncFs, "fsyncSync").mockImplementationOnce((fd) => {
            fsync(fd);
            revoke();
          });
        }
      };
      return await withConfigWriteLock(
        configPath,
        async () =>
          withConfigWriteLock(
            includePath,
            async () => {
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
            },
            env,
            () => fence.assertCurrent(),
          ),
        env,
        () => fence.assertCurrent(),
      );
    });
    if (included) {
      // These revocations were scheduled at commit/fsync. Guarded includes now
      // refuse before either boundary; they must not reach those callbacks.
      await expect(owned).rejects.toThrow(new Error(GUARDED_CONFIG_INCLUDE_WRITE_ERROR));
      expect(reachedCommit).toBe(false);
      expect(await captureFiles()).toEqual(beforeFiles);
      expect([await fs.readdir(stateDir), await fs.readdir(path.dirname(includePath))]).toEqual(
        beforeEntries,
      );
    } else {
      if (revoked) {
        await expect(owned).rejects.toThrow(/executor|ownership/i);
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
      } else {
        await owned;
        expect(JSON.parse(await fs.readFile(configPath, "utf8")).gateway.port).toBe(18791);
      }
      expect(reachedCommit).toBe(true);
    }
    if (included && process.platform !== "win32") {
      expect((await fs.stat(path.dirname(includePath))).mode & 0o7777).toBe(0o3700);
    }
  },
);

it("preserves ordinary unguarded include publication", async () => {
  const home = await fs.realpath(dirs.make("update-config-unguarded-include-"));
  const configPath = path.join(home, "openclaw.json");
  const includePath = path.join(home, "gateway.json");
  const original = '{"gateway":{"$include":"./gateway.json"}}\n';
  const includedRaw = '{"mode":"local","port":18789}\n';
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_STATE_DIR: home,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  await fs.writeFile(configPath, original);
  await fs.writeFile(includePath, includedRaw);
  const io = createConfigIO({ configPath, env, observe: false, pluginValidation: "skip" });
  const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
  await replaceConfigFile({
    snapshot,
    baseHash: snapshot.hash,
    nextConfig: {
      ...snapshot.sourceConfig,
      gateway: { ...snapshot.sourceConfig.gateway, port: 18791 },
    },
    writeOptions: { ...writeOptions, skipPluginValidation: true },
    io: { ...io, env },
  });
  expect(await fs.readFile(configPath, "utf8")).toBe(original);
  expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual({
    mode: "local",
    port: 18791,
  });
  expect(await fs.readFile(`${includePath}.bak`, "utf8")).toBe(includedRaw);
});
