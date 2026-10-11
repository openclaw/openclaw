import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as configJournal from "../config/config-journal-snapshot.js";
import * as configIo from "../config/config.js";
import * as configAudit from "../config/io.audit.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import * as configWriteLock from "../config/write-lock.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
  recordDeferredPluginMigrationsInTransaction,
} from "../infra/deferred-plugin-migrations.js";
import { selectInstallMutationWriteOptions } from "../plugins/install-config-mutation.js";
import { persistPluginInstall } from "../plugins/install-persistence.js";
import { resolvePluginInstallTransactionRequest } from "../plugins/install-transaction.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { PluginInstallPersistedError } from "../plugins/lifecycle.js";
import { PLUGIN_LIFECYCLE_LEASE_IDENTITY } from "../plugins/plugin-lifecycle-lease-identity.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import { updateNpmInstalledPlugins } from "../plugins/update.js";
import { defaultRuntime } from "../runtime.js";
import { openClawStateDatabaseCache } from "../state/openclaw-state-db-cache.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as leaseStore from "../state/openclaw-state-lease-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runPluginUpdateCommand } from "./plugins-update-command.js";

vi.mock("../plugins/update.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/update.js")>()),
  updateNpmInstalledPlugins: vi.fn(),
}));
const gateway = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./plugins-lifecycle-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugins-lifecycle-client.js")>()),
  resolvePluginLifecycleGateway: async () => gateway.call,
}));
afterEach(() => vi.restoreAllMocks());

describe("installed plugin update config migration", () => {
  it.each([
    "updated",
    "non-channel-config-repair",
    "legacy-contract-ready",
    "legacy-contract-no-config",
    "legacy-contract-failure",
    "unchanged",
    "unchanged-ready",
    "include",
    "include-post-publish-failure",
    "root-after-completion-failure",
    "include-after-completion-failure",
    "root-rollback-postverify-failure",
    "include-rollback-postverify-failure",
    "rollback-generation-conflict",
    "accepted-update-failure",
    "accepted-install-failure",
    "accepted-update-superseded",
    "accepted-install-superseded",
    "env-reference",
    "install-replacement",
    "disabled-update",
    "disabled-install",
    "unrelated-pending",
    "unrelated-core-legacy",
    "partial-update",
    "constructor-failure",
    "wrong-doctor-surface",
    "declared-unrelated-surface",
    "missing-normalizer",
    "rules-only-no-pending",
    "rules-only-ready",
    "rules-only-pending-ready",
    "transform-failure",
    "state-migration",
    "state-migration-install",
    "write-failure",
    "revoked",
  ] as const)("preserves listener settings and completion authority: %s", async (scenario) => {
    await withOpenClawTestState(
      {
        label: "plugin-update-migration",
        env: { LISTENER_HOST: "127.0.0.1", OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      },
      async (state) => {
        const pluginId = "listener-fixture";
        const pendingState =
          scenario === "state-migration" || scenario === "state-migration-install";
        const packageName = "@acme/listener-fixture";
        const retainsOther =
          scenario === "unrelated-pending" ||
          scenario === "partial-update" ||
          scenario === "unrelated-core-legacy";
        const inactive = scenario === "disabled-update" || scenario === "disabled-install";
        const included =
          scenario === "include" ||
          scenario === "include-post-publish-failure" ||
          scenario === "include-after-completion-failure" ||
          scenario === "include-rollback-postverify-failure";
        const afterCompletion =
          scenario === "root-after-completion-failure" ||
          scenario === "include-after-completion-failure" ||
          scenario === "root-rollback-postverify-failure" ||
          scenario === "include-rollback-postverify-failure" ||
          scenario === "rollback-generation-conflict";
        const postverifyFailure =
          scenario === "root-rollback-postverify-failure" ||
          scenario === "include-rollback-postverify-failure";
        const acceptedFailure =
          scenario === "accepted-update-failure" ||
          scenario === "accepted-install-failure" ||
          scenario === "accepted-update-superseded" ||
          scenario === "accepted-install-superseded";
        const superseded =
          scenario === "accepted-update-superseded" || scenario === "accepted-install-superseded";
        const installScenario =
          scenario === "install-replacement" ||
          scenario === "disabled-install" ||
          scenario === "state-migration-install" ||
          scenario === "accepted-install-failure" ||
          scenario === "accepted-install-superseded";
        const incompleteContract =
          scenario === "constructor-failure" ||
          scenario === "legacy-contract-failure" ||
          scenario === "missing-normalizer" ||
          scenario === "rules-only-no-pending" ||
          scenario === "declared-unrelated-surface" ||
          scenario === "wrong-doctor-surface";
        const ready =
          scenario === "unchanged-ready" ||
          scenario === "legacy-contract-no-config" ||
          scenario === "rules-only-ready" ||
          scenario === "rules-only-pending-ready";
        const settled =
          ready &&
          scenario !== "rules-only-pending-ready" &&
          scenario !== "legacy-contract-no-config";
        const alreadyCurrent = scenario === "unchanged" || ready;
        const unselectedMarker = state.path("unselected-doctor-ran");
        const config = {
          ...(scenario === "unrelated-core-legacy"
            ? { memory: { search: { provider: "auto" } } }
            : {}),
          plugins: {
            allow: [pluginId, ...(scenario === "partial-update" ? ["unavailable-owner"] : [])],
            entries: {
              ...(retainsOther
                ? {
                    "unavailable-owner": {
                      enabled: scenario === "partial-update",
                      config: { retainedInput: "keep-me" },
                    },
                  }
                : {}),
              [pluginId]: {
                enabled: !inactive,
                config: {
                  ...(ready
                    ? { listener: { port: 57597, host: "${LISTENER_HOST}" } }
                    : { oldPort: 57597 }),
                  label: "kept",
                  ...(scenario === "env-reference" ? { oldHost: "${LISTENER_HOST}" } : {}),
                },
              },
            },
          },
        };
        const writePlugin = (version: "1.0.0" | "2.0.0") => {
          const root = writeManagedNpmPlugin({
            stateDir: version === "1.0.0" ? state.stateDir : state.path("candidate"),
            packageName,
            pluginId,
            version,
          });
          const packagePath = path.join(root, "package.json");
          const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
          manifest.openclaw.setupEntry = "./setup-entry.mjs";
          fs.writeFileSync(packagePath, JSON.stringify(manifest));
          fs.writeFileSync(
            path.join(root, "setup-entry.mjs"),
            `export default {
          kind: "bundled-channel-setup-entry", features: {}, loadSetupPlugin() { return {}; },
          ${inactive && version === "2.0.0" ? 'loadLegacyStateMigrationDetector() { throw new Error("disabled state work must not run"); },' : pendingState && version === "2.0.0" ? 'loadLegacyStateMigrationDetector() { return () => { throw new Error("data migration must use Doctor maintenance"); }; },' : ""}
        };`,
          );
          fs.writeFileSync(
            path.join(root, "openclaw.plugin.json"),
            JSON.stringify({
              id: pluginId,
              channels: scenario === "non-channel-config-repair" ? [] : [pluginId],
              ...(version === "2.0.0" &&
              scenario !== "legacy-contract-ready" &&
              scenario !== "legacy-contract-no-config" &&
              scenario !== "legacy-contract-failure"
                ? {
                    doctorContract:
                      scenario === "declared-unrelated-surface"
                        ? { resolveSessionStoreAgentIds: true }
                        : { configRepair: true },
                  }
                : {}),
              configSchema: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  ...(version === "1.0.0"
                    ? { oldPort: { type: "number" }, oldHost: { type: "string" } }
                    : {
                        listener: {
                          type: "object",
                          properties: { port: { type: "number" }, host: { type: "string" } },
                        },
                      }),
                },
                additionalProperties: incompleteContract,
              },
            }),
          );
          return root;
        };
        const previousPath = writePlugin("1.0.0");
        const candidatePath = writePlugin("2.0.0");
        fs.writeFileSync(
          path.join(candidatePath, "doctor-contract-api.mjs"),
          scenario === "wrong-doctor-surface" ||
            scenario === "declared-unrelated-surface" ||
            scenario === "legacy-contract-no-config"
            ? "export function resolveSessionStoreAgentIds() { return []; }"
            : scenario === "missing-normalizer" ||
                scenario === "rules-only-no-pending" ||
                scenario === "rules-only-ready" ||
                scenario === "rules-only-pending-ready"
              ? 'export const legacyConfigRules = [{ path: ["plugins", "entries", "listener-fixture", "config", "oldPort"], message: "Legacy listener requires repair." }];'
              : `
        ${scenario === "constructor-failure" || scenario === "legacy-contract-failure" ? 'throw new Error("fixture constructor refused");' : ""}
        ${scenario === "unrelated-core-legacy" ? 'export const legacyConfigRules = [{ path: ["plugins", "entries", "listener-fixture", "config", "oldPort"], message: "Legacy listener requires repair." }];' : ""}
        export function normalizeCompatibilityConfig({ cfg }) {
          ${scenario === "transform-failure" ? 'throw new Error("fixture transform refused");' : ""}
          const config = structuredClone(cfg);
          const settings = config.plugins.entries["listener-fixture"].config;
          if (settings.oldPort === undefined) return { config, changes: [] };
          settings.listener = { port: settings.oldPort };
          if (settings.oldHost !== undefined) settings.listener.host = settings.oldHost;
          delete settings.oldPort;
          delete settings.oldHost;
          return { config, changes: ["Moved the configured listener port."] };
        }`,
        );
        if (included) {
          fs.writeFileSync(state.statePath("plugins.json"), JSON.stringify(config.plugins));
          await state.writeConfig({ plugins: { $include: state.statePath("plugins.json") } });
        } else {
          await state.writeConfig(config);
        }
        const otherRecords: Record<string, PluginInstallRecord> = {};
        if (scenario === "partial-update") {
          const installPath = writeManagedNpmPlugin({
            stateDir: state.stateDir,
            packageName: "@acme/unavailable-owner",
            pluginId: "unavailable-owner",
            version: "1.0.0",
          });
          fs.writeFileSync(
            path.join(installPath, "openclaw.plugin.json"),
            JSON.stringify({
              id: "unavailable-owner",
              doctorContract: { configRepair: true },
              configSchema: { type: "object" },
            }),
          );
          fs.writeFileSync(
            path.join(installPath, "doctor-contract-api.mjs"),
            `
            import fs from "node:fs";
            fs.writeFileSync(${JSON.stringify(unselectedMarker)}, "ran");
            throw new Error("failed package must not run config repair");
          `,
          );
          otherRecords["unavailable-owner"] = {
            source: "npm",
            spec: "@acme/unavailable-owner@1.0.0",
            installPath,
          };
        }
        const previousRecords = {
          ...otherRecords,
          [pluginId]: {
            source: "npm" as const,
            spec: `${packageName}@1.0.0`,
            installPath: previousPath,
          },
        };
        const nextRecords = {
          ...otherRecords,
          [pluginId]: {
            source: "npm" as const,
            spec: `${packageName}@2.0.0`,
            installPath: candidatePath,
            installedAt: "2026-09-01T00:00:00.000Z",
          },
        };
        await seedInstalledPluginIndex(ready ? nextRecords : previousRecords, {
          config,
          env: state.env,
        });
        if (!settled && scenario !== "rules-only-no-pending") {
          await recordDeferredPluginMigrations({
            env: state.env,
            pending: [
              {
                pluginId,
                reason: "The previous updater retained the installed package.",
                command: "openclaw doctor --fix",
                ...(inactive || pendingState ? { requiresStateMigration: true as const } : {}),
                configPaths: [["plugins", "entries", pluginId, "config", "oldPort"]],
                validationExcludedPaths: [["plugins", "entries", pluginId, "config", "oldPort"]],
              },
            ],
          });
        }
        const unrelated = {
          pluginId: "unavailable-owner",
          reason: "Its data migration remains unresolved.",
          command: "openclaw doctor --fix",
          requiresStateMigration: true as const,
          configPaths: [
            ["plugins", "entries", "unavailable-owner", "config"],
            ...(scenario === "unrelated-core-legacy" ? [["memory"]] : []),
          ],
          ...(scenario === "unrelated-core-legacy"
            ? { validationExcludedPaths: [["memory"]] }
            : {}),
        };
        if (retainsOther) {
          await recordDeferredPluginMigrations({ env: state.env, pending: [unrelated] });
        }
        if (scenario === "unchanged") {
          await seedInstalledPluginIndex(nextRecords, { config, env: state.env });
        }
        const beforeConfig = fs.readFileSync(state.configPath, "utf8");
        const includePath = state.statePath("plugins.json");
        const beforeInclude = included ? fs.readFileSync(includePath, "utf8") : undefined;
        const beforePending = readDeferredPluginMigrations({ env: state.env });
        const newerPending = {
          pluginId,
          reason: "A newer inspection retained more inputs.",
          command: "openclaw doctor --fix",
          requiresStateMigration: true as const,
          configPaths: [["plugins", "entries", pluginId, "config"]],
        };
        const newerRecords = {
          [pluginId]: { ...nextRecords[pluginId], installedAt: "2026-09-02T00:00:00.000Z" },
        };
        const payload = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
        vi.mocked(updateNpmInstalledPlugins).mockImplementation(async (params) => {
          if (acceptedFailure) {
            const sink = resolvePluginInstallTransactionRequest(params)?.transactionSink;
            if (!sink) {
              throw new Error("Fixture requires the real deferred install request.");
            }
            sink.push(payload);
          }
          return {
            config: {
              ...params.config,
              plugins: { ...params.config.plugins, installs: nextRecords },
            },
            changed: !alreadyCurrent,
            outcomes: [
              {
                pluginId,
                status: alreadyCurrent ? "unchanged" : "updated",
                message: "fixture package ready",
              },
              ...(scenario === "partial-update"
                ? [
                    {
                      pluginId: "unavailable-owner",
                      status: "error" as const,
                      message: "fixture target unavailable",
                    },
                  ]
                : []),
            ],
          };
        });
        const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
        const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
        vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
          throw new Error(`unexpected CLI exit ${code}: ${errors.mock.calls.flat().join("; ")}`);
        });
        const failure = [
          "constructor-failure",
          "legacy-contract-failure",
          "wrong-doctor-surface",
          "declared-unrelated-surface",
          "missing-normalizer",
          "rules-only-no-pending",
          "include-post-publish-failure",
          "root-after-completion-failure",
          "include-after-completion-failure",
          "root-rollback-postverify-failure",
          "include-rollback-postverify-failure",
          "rollback-generation-conflict",
          "transform-failure",
          "write-failure",
          "revoked",
        ].includes(scenario);
        gateway.call.mockReset();
        if (scenario === "write-failure") {
          vi.spyOn(configIo, "replaceConfigFile").mockRejectedValueOnce(
            new Error("fixture publication refused"),
          );
        }
        let refusedAfterPublication = false;
        let refusedAfterCompletion = false;
        let rollbackVerificationFailed = false;
        const rollbackVerificationError = new Error(
          "fixture rollback verification refused after rename",
        );
        if (postverifyFailure) {
          const captureGuard = configWriteLock.captureConfigWriteLockGuard;
          vi.spyOn(configWriteLock, "captureConfigWriteLockGuard").mockImplementation(
            (configPath) => {
              const guard = captureGuard(configPath);
              return guard
                ? () => {
                    guard();
                    if (rollbackVerificationFailed) {
                      throw rollbackVerificationError;
                    }
                  }
                : undefined;
            },
          );
          const rollbackPath = included ? includePath : state.configPath;
          const lstatSync = fs.lstatSync;
          vi.spyOn(fs, "lstatSync").mockImplementation(
            new Proxy(lstatSync, {
              apply(target, thisArg, args) {
                const result = Reflect.apply(target, thisArg, args);
                if (
                  refusedAfterCompletion &&
                  !rollbackVerificationFailed &&
                  args[0] === rollbackPath &&
                  fs.existsSync(rollbackPath) &&
                  fs.readFileSync(rollbackPath, "utf8") ===
                    (included ? beforeInclude : beforeConfig)
                ) {
                  rollbackVerificationFailed = true;
                  throw rollbackVerificationError;
                }
                return result;
              },
            }),
          );
        }
        if (afterCompletion) {
          const readExpiry = leaseStore.readOpenClawStateLeaseExpiry;
          let inspectingCompletion = false;
          vi.spyOn(leaseStore, "readOpenClawStateLeaseExpiry").mockImplementation((...args) => {
            const database = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(
              resolveOpenClawStateSqlitePath(state.env),
            );
            if (
              !refusedAfterCompletion &&
              !inspectingCompletion &&
              args[1].scope === PLUGIN_LIFECYCLE_LEASE_IDENTITY.scope &&
              database &&
              !database.db.isTransaction
            ) {
              inspectingCompletion = true;
              try {
                if (
                  fs.readFileSync(included ? includePath : state.configPath, "utf8") !==
                    (included ? beforeInclude : beforeConfig) &&
                  readDeferredPluginMigrations({ env: state.env }).length === 0
                ) {
                  refusedAfterCompletion = true;
                  if (scenario === "rollback-generation-conflict") {
                    runOpenClawStateWriteTransaction(
                      ({ db }) =>
                        recordDeferredPluginMigrationsInTransaction(db, {
                          pending: [newerPending],
                          expectedPending: [],
                        }),
                      { env: state.env },
                    );
                  }
                  throw new Error("fixture authority revoked after migration completion");
                }
              } finally {
                inspectingCompletion = false;
              }
            }
            return readExpiry(...args);
          });
        }
        if (scenario === "include-post-publish-failure") {
          const readExpiry = leaseStore.readOpenClawStateLeaseExpiry;
          vi.spyOn(leaseStore, "readOpenClawStateLeaseExpiry").mockImplementation((...args) => {
            if (
              !refusedAfterPublication &&
              fs.readFileSync(includePath, "utf8") !== beforeInclude
            ) {
              refusedAfterPublication = true;
              throw new Error("fixture post-publication authority refused");
            }
            return readExpiry(...args);
          });
        }
        if (scenario === "revoked") {
          let revoked = false;
          const readExpiry = leaseStore.readOpenClawStateLeaseExpiry;
          vi.spyOn(leaseStore, "readOpenClawStateLeaseExpiry").mockImplementation((...args) => {
            if (revoked) {
              throw new Error("fixture authority revoked");
            }
            return readExpiry(...args);
          });
          const replaceConfig = configIo.replaceConfigFile;
          vi.spyOn(configIo, "replaceConfigFile").mockImplementation((params) =>
            replaceConfig({
              ...params,
              writeOptions: {
                ...params.writeOptions,
                beforeCommit: async () => {
                  await params.writeOptions?.beforeCommit?.();
                  revoked = true;
                },
              },
            }),
          );
        }
        let auditRefused = false;
        const auditFailure = new Error("fixture accepted audit fingerprint failed");
        if (acceptedFailure) {
          const auditBaseline = { plugins: {} };
          await configJournal.upsertConfigSnapshotAuditRecordAsync({
            env: state.env,
            configPath: state.configPath,
            rawHash: hashConfigRaw(JSON.stringify(auditBaseline)),
            authoredConfig: auditBaseline,
          });
          const fingerprint = configJournal.fingerprintConfigSnapshotAuthoredConfig;
          vi.spyOn(configJournal, "fingerprintConfigSnapshotAuthoredConfig").mockImplementation(
            (...args) => {
              if (
                fs.readFileSync(state.configPath, "utf8") !== beforeConfig &&
                readDeferredPluginMigrations({ env: state.env }).length === 0
              ) {
                auditRefused = true;
                throw auditFailure;
              }
              return fingerprint(...args);
            },
          );
          if (superseded) {
            const append = configAudit.appendConfigAuditRecord;
            let advanced = false;
            vi.spyOn(configAudit, "appendConfigAuditRecord").mockImplementation(async (...args) => {
              await append(...args);
              if (
                !advanced &&
                fs.readFileSync(state.configPath, "utf8") !== beforeConfig &&
                readDeferredPluginMigrations({ env: state.env }).length === 0
              ) {
                advanced = true;
                await seedInstalledPluginIndex(newerRecords, {
                  config: JSON.parse(fs.readFileSync(state.configPath, "utf8")),
                  env: state.env,
                });
              }
            });
          }
        }
        const applyRuntime = vi.fn();
        const command = installScenario
          ? (async () => {
              const prepared = await configIo.readConfigFileSnapshotForWrite();
              return await persistPluginInstall({
                snapshot: {
                  config: prepared.snapshot.sourceConfig,
                  baseHash: prepared.snapshot.hash,
                  writeOptions: selectInstallMutationWriteOptions(prepared.writeOptions),
                },
                pluginId,
                install: nextRecords[pluginId],
                invalidateRuntimeCache: false,
                ...(pendingState ? { applyRuntime } : {}),
                ...(acceptedFailure ? { transaction: payload } : {}),
                ...(scenario === "disabled-install" ? { enable: false } : {}),
              });
            })()
          : runPluginUpdateCommand({
              ids: [pluginId, ...(scenario === "partial-update" ? ["unavailable-owner"] : [])],
              opts: {},
            });
        if (acceptedFailure) {
          const error: unknown = await command.then(
            () => undefined,
            (rejection: unknown) => rejection,
          );
          const configError = error instanceof PluginInstallPersistedError ? error.cause : error;
          expect(configError).toBeInstanceOf(ConfigWritePostCommitError);
          if (!(configError instanceof ConfigWritePostCommitError)) {
            throw new Error("Expected published config failure");
          }
          expect(configError.cause).toBe(auditFailure);
          expect(auditRefused).toBe(true);
          expect(
            JSON.parse(fs.readFileSync(state.configPath, "utf8")).plugins.entries[pluginId].config,
          ).toEqual({ listener: { port: 57597 }, label: "kept" });
          expect(readDeferredPluginMigrations({ env: state.env })).toEqual([]);
          expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(
            superseded ? newerRecords : nextRecords,
          );
          expect(payload.commit).toHaveBeenCalledTimes(1);
          expect(payload.rollback).not.toHaveBeenCalled();
          expect(gateway.call).not.toHaveBeenCalled();
          expect(log).not.toHaveBeenCalledWith(
            "Updates saved; they will load on the next Gateway start.",
          );
          if (superseded) {
            expect(error).not.toBeInstanceOf(PluginInstallPersistedError);
          }
          if (installScenario && !superseded) {
            expect(error).toBeInstanceOf(PluginInstallPersistedError);
          }
          return;
        }
        if (failure) {
          const reason =
            scenario === "missing-normalizer" || scenario === "rules-only-no-pending"
              ? "Legacy listener requires repair"
              : scenario === "constructor-failure" ||
                  scenario === "wrong-doctor-surface" ||
                  scenario === "declared-unrelated-surface" ||
                  scenario === "legacy-contract-failure"
                ? "Plugin config repair could not be inspected"
                : scenario === "transform-failure"
                  ? "fixture transform refused"
                  : scenario === "write-failure"
                    ? "fixture publication refused"
                    : scenario === "include-post-publish-failure"
                      ? "failed to verify plugin lifecycle lease"
                      : undefined;
          await expect(command).rejects.toThrow(reason);
          if (scenario === "rollback-generation-conflict") {
            expect(
              JSON.parse(fs.readFileSync(state.configPath, "utf8")).plugins.entries[pluginId]
                .config,
            ).toEqual({ listener: { port: 57597 }, label: "kept" });
          } else {
            expect(fs.readFileSync(state.configPath, "utf8")).toBe(beforeConfig);
          }
          if (included) {
            expect(refusedAfterPublication || refusedAfterCompletion).toBe(true);
            expect(fs.readFileSync(includePath, "utf8")).toBe(beforeInclude);
          }
          if (afterCompletion) {
            expect(refusedAfterCompletion).toBe(true);
          }
          if (postverifyFailure) {
            expect(rollbackVerificationFailed).toBe(true);
          }
          expect(readDeferredPluginMigrations({ env: state.env })).toEqual(
            scenario === "rollback-generation-conflict" ? [newerPending] : beforePending,
          );
          expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(
            scenario === "revoked" || scenario === "include-post-publish-failure" || afterCompletion
              ? nextRecords
              : previousRecords,
          );
          expect(gateway.call).not.toHaveBeenCalled();
          expect(log).not.toHaveBeenCalledWith(
            "Updates saved; they will load on the next Gateway start.",
          );
          return;
        }
        if (scenario === "partial-update") {
          await expect(command).rejects.toThrow("unexpected CLI exit 1");
        } else {
          await command;
        }
        expect(gateway.call).not.toHaveBeenCalled();
        const saved = JSON.parse(fs.readFileSync(state.configPath, "utf8"));
        if (scenario === "unrelated-core-legacy") {
          expect(saved.memory).toEqual({ search: { provider: "auto" } });
        }
        const plugins =
          scenario === "include"
            ? JSON.parse(fs.readFileSync(state.statePath("plugins.json"), "utf8"))
            : saved.plugins;
        if (scenario === "include") {
          expect(saved.plugins).toEqual({ $include: state.statePath("plugins.json") });
        }
        expect(plugins.entries[pluginId].config).toEqual({
          ...(inactive || pendingState ? { oldPort: 57597 } : {}),
          listener: {
            port: 57597,
            ...(scenario === "env-reference" || ready ? { host: "${LISTENER_HOST}" } : {}),
          },
          label: "kept",
        });
        if (retainsOther) {
          expect(plugins.entries["unavailable-owner"]).toEqual({
            enabled: scenario === "partial-update",
            config: { retainedInput: "keep-me" },
          });
        }
        expect(readDeferredPluginMigrations({ env: state.env })).toEqual(
          inactive || pendingState ? beforePending : retainsOther ? [unrelated] : [],
        );
        expect(readPersistedInstalledPluginIndexInstallRecords({ env: state.env })).toEqual(
          nextRecords,
        );
        if (inactive) {
          expect(plugins.entries[pluginId].enabled).toBe(false);
        }
        if (scenario === "partial-update") {
          expect(fs.existsSync(unselectedMarker)).toBe(false);
        }
        if (pendingState) {
          expect(applyRuntime).not.toHaveBeenCalled();
          expect(gateway.call).not.toHaveBeenCalled();
          expect(log.mock.calls.flat().join("\n")).toContain("openclaw doctor --fix");
          expect(fs.existsSync(previousPath)).toBe(true);
        } else if (settled) {
          expect(fs.readFileSync(state.configPath, "utf8")).toBe(beforeConfig);
          expect(log).not.toHaveBeenCalledWith(
            "Updates saved; they will load on the next Gateway start.",
          );
        } else if (scenario !== "install-replacement" && scenario !== "disabled-install") {
          expect(log).toHaveBeenCalledWith(
            "Updates saved; they will load on the next Gateway start.",
          );
        }
      },
    );
  });
});
