import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
import { readPersistedInstalledPluginIndexInstallRecordsAsync as readInstallRecords } from "../plugins/installed-plugin-index-records.js";
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
const readText = (file: string) => fs.readFileSync(file, "utf8");
const readJson = (file: string) => JSON.parse(readText(file));
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value));
const savedMessage = "Updates saved; they will load on the next Gateway start.";
const entry = (enabled: boolean, config: Record<string, unknown>) => ({ enabled, config });
const schema = (properties: Record<string, unknown>, additionalProperties?: boolean) => ({
  type: "object",
  properties,
  additionalProperties,
});
function interceptLeaseRead(
  check: (...args: Parameters<typeof leaseStore.readOpenClawStateLeaseExpiry>) => void,
) {
  const read = leaseStore.readOpenClawStateLeaseExpiry;
  vi.spyOn(leaseStore, "readOpenClawStateLeaseExpiry").mockImplementation((...args) => {
    check(...args);
    return read(...args);
  });
}

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
      const env = state.env;
      const pending = () => readDeferredPluginMigrations({ env });
      const records = () => readInstallRecords({ env });
      const configText = () => readText(state.configPath);
      const savedSettings = () => readJson(state.configPath).plugins.entries[pluginId].config;
      const is = (...names: string[]) => names.includes(scenario);
      const pluginId = "listener-fixture";
      const legacyPath = ["plugins", "entries", pluginId, "config", "oldPort"];
      const pendingState = scenario.startsWith("state-migration");
      const packageName = "@acme/listener-fixture";
      const managedPlugin = (id: string, version: string, stateDir = state.stateDir) =>
        writeManagedNpmPlugin({ stateDir, pluginId: id, packageName: `@acme/${id}`, version });
      const retainsOther = is("unrelated-pending", "partial-update", "unrelated-core-legacy");
      const inactive = scenario.startsWith("disabled-");
      const included = scenario.startsWith("include");
      const afterCompletion =
        scenario.includes("after-completion") ||
        scenario.includes("rollback-postverify") ||
        scenario === "rollback-generation-conflict";
      const postverifyFailure = scenario.includes("rollback-postverify");
      const acceptedFailure = scenario.startsWith("accepted-");
      const superseded = scenario.endsWith("-superseded");
      const installScenario = scenario.includes("install");
      const incompleteContract = is(
        "constructor-failure",
        "legacy-contract-failure",
        "missing-normalizer",
        "rules-only-no-pending",
        "declared-unrelated-surface",
        "wrong-doctor-surface",
      );
      const ready = is(
        "unchanged-ready",
        "legacy-contract-no-config",
        "rules-only-ready",
        "rules-only-pending-ready",
      );
      const settled = ready && !is("rules-only-pending-ready", "legacy-contract-no-config");
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
                  "unavailable-owner": entry(scenario === "partial-update", {
                    retainedInput: "keep-me",
                  }),
                }
              : {}),
            [pluginId]: entry(!inactive, {
              ...(ready
                ? { listener: { port: 57597, host: "${LISTENER_HOST}" } }
                : { oldPort: 57597 }),
              label: "kept",
              ...(scenario === "env-reference" ? { oldHost: "${LISTENER_HOST}" } : {}),
            }),
          },
        },
      };
      const writePlugin = (version: "1.0.0" | "2.0.0") => {
        const old = version === "1.0.0";
        const root = managedPlugin(
          pluginId,
          version,
          old ? state.stateDir : state.path("candidate"),
        );
        const packagePath = path.join(root, "package.json");
        const manifest = readJson(packagePath);
        manifest.openclaw.setupEntry = "./setup-entry.mjs";
        writeJson(packagePath, manifest);
        fs.writeFileSync(
          path.join(root, "setup-entry.mjs"),
          `export default {
          kind: "bundled-channel-setup-entry", features: {}, loadSetupPlugin() { return {}; },
          ${inactive && version === "2.0.0" ? 'loadLegacyStateMigrationDetector() { throw new Error("disabled state work must not run"); },' : pendingState && version === "2.0.0" ? 'loadLegacyStateMigrationDetector() { return () => { throw new Error("data migration must use Doctor maintenance"); }; },' : ""}
        };`,
        );
        writeJson(path.join(root, "openclaw.plugin.json"), {
          id: pluginId,
          channels: scenario === "non-channel-config-repair" ? [] : [pluginId],
          doctorContract:
            old || scenario.startsWith("legacy-contract-")
              ? undefined
              : scenario === "declared-unrelated-surface"
                ? { resolveSessionStoreAgentIds: true }
                : { configRepair: true },
          configSchema: schema(
            {
              label: { type: "string" },
              ...(old
                ? { oldPort: { type: "number" }, oldHost: { type: "string" } }
                : {
                    listener: schema({ port: { type: "number" }, host: { type: "string" } }),
                  }),
            },
            incompleteContract,
          ),
        });
        return root;
      };
      const previousPath = writePlugin("1.0.0");
      const candidatePath = writePlugin("2.0.0");
      fs.writeFileSync(
        path.join(candidatePath, "doctor-contract-api.mjs"),
        is("wrong-doctor-surface", "declared-unrelated-surface", "legacy-contract-no-config")
          ? "export function resolveSessionStoreAgentIds() { return []; }"
          : scenario === "missing-normalizer" || scenario.startsWith("rules-only-")
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
        writeJson(state.statePath("plugins.json"), config.plugins);
        await state.writeConfig({ plugins: { $include: state.statePath("plugins.json") } });
      } else {
        await state.writeConfig(config);
      }
      const otherRecords: Record<string, PluginInstallRecord> = {};
      if (scenario === "partial-update") {
        const installPath = managedPlugin("unavailable-owner", "1.0.0");
        writeJson(path.join(installPath, "openclaw.plugin.json"), {
          id: "unavailable-owner",
          doctorContract: { configRepair: true },
          configSchema: { type: "object" },
        });
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
      const installRecord = (installPath: string, version: string) => ({
        source: "npm" as const,
        spec: `${packageName}@${version}`,
        installPath,
      });
      const previousRecords = { ...otherRecords, [pluginId]: installRecord(previousPath, "1.0.0") };
      const nextRecords = {
        ...otherRecords,
        [pluginId]: {
          ...installRecord(candidatePath, "2.0.0"),
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
              configPaths: [legacyPath],
              validationExcludedPaths: [legacyPath],
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
        ...(scenario === "unrelated-core-legacy" ? { validationExcludedPaths: [["memory"]] } : {}),
      };
      if (retainsOther) {
        await recordDeferredPluginMigrations({ env: state.env, pending: [unrelated] });
      }
      if (scenario === "unchanged") {
        await seedInstalledPluginIndex(nextRecords, { config, env: state.env });
      }
      const beforeConfig = configText();
      const includePath = state.statePath("plugins.json");
      const beforeInclude = included ? readText(includePath) : undefined;
      const beforePending = pending();
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
      const inspectionFailure = is(
        "constructor-failure",
        "legacy-contract-failure",
        "wrong-doctor-surface",
        "declared-unrelated-surface",
      );
      const reason = is("missing-normalizer", "rules-only-no-pending")
        ? "Legacy listener requires repair"
        : inspectionFailure
          ? "Plugin config repair could not be inspected"
          : scenario === "transform-failure"
            ? "fixture transform refused"
            : scenario === "write-failure"
              ? "fixture publication refused"
              : scenario === "include-post-publish-failure"
                ? "failed to verify plugin lifecycle lease"
                : undefined;
      const failure = reason !== undefined || afterCompletion || scenario === "revoked";
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
                readText(rollbackPath) === (included ? beforeInclude : beforeConfig)
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
        let inspectingCompletion = false;
        interceptLeaseRead((...args) => {
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
                readText(included ? includePath : state.configPath) !==
                  (included ? beforeInclude : beforeConfig) &&
                pending().length === 0
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
        });
      }
      if (scenario === "include-post-publish-failure") {
        interceptLeaseRead(() => {
          if (!refusedAfterPublication && readText(includePath) !== beforeInclude) {
            refusedAfterPublication = true;
            throw new Error("fixture post-publication authority refused");
          }
        });
      }
      if (scenario === "revoked") {
        let revoked = false;
        interceptLeaseRead(() => {
          if (revoked) {
            throw new Error("fixture authority revoked");
          }
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
            if (configText() !== beforeConfig && pending().length === 0) {
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
            if (!advanced && configText() !== beforeConfig && pending().length === 0) {
              advanced = true;
              await seedInstalledPluginIndex(newerRecords, {
                config: readJson(state.configPath),
                env: state.env,
              });
            }
          });
        }
      }
      const applyRuntime = vi.fn();
      const expectedNextRecords = installScenario
        ? {
            ...nextRecords,
            [pluginId]: {
              ...nextRecords[pluginId],
              sourceSnapshotDigests: {
                [pluginId]: {
                  contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
                  dependencyClosureDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
                },
              },
            },
          }
        : nextRecords;
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
        expect(savedSettings()).toEqual({ listener: { port: 57597 }, label: "kept" });
        expect(pending()).toEqual([]);
        expect(await records()).toEqual(superseded ? newerRecords : expectedNextRecords);
        expect(payload.commit).toHaveBeenCalledTimes(1);
        expect(payload.rollback).not.toHaveBeenCalled();
        expect(gateway.call).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalledWith(savedMessage);
        if (superseded) {
          expect(error).not.toBeInstanceOf(PluginInstallPersistedError);
        }
        if (installScenario && !superseded) {
          expect(error).toBeInstanceOf(PluginInstallPersistedError);
        }
        return;
      }
      if (failure) {
        await expect(command).rejects.toThrow(reason);
        if (scenario === "rollback-generation-conflict") {
          expect(savedSettings()).toEqual({ listener: { port: 57597 }, label: "kept" });
        } else {
          expect(configText()).toBe(beforeConfig);
        }
        if (included) {
          expect(refusedAfterPublication || refusedAfterCompletion).toBe(true);
          expect(readText(includePath)).toBe(beforeInclude);
        }
        if (afterCompletion) {
          expect(refusedAfterCompletion).toBe(true);
        }
        if (postverifyFailure) {
          expect(rollbackVerificationFailed).toBe(true);
        }
        expect(pending()).toEqual(
          scenario === "rollback-generation-conflict" ? [newerPending] : beforePending,
        );
        expect(await records()).toEqual(
          is("revoked", "include-post-publish-failure") || afterCompletion
            ? nextRecords
            : previousRecords,
        );
        expect(gateway.call).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalledWith(savedMessage);
        return;
      }
      if (scenario === "partial-update") {
        await expect(command).rejects.toThrow("unexpected CLI exit 1");
      } else {
        await command;
      }
      expect(gateway.call).not.toHaveBeenCalled();
      const saved = readJson(state.configPath);
      if (scenario === "unrelated-core-legacy") {
        expect(saved.memory).toEqual({ search: { provider: "auto" } });
      }
      const plugins = scenario === "include" ? readJson(includePath) : saved.plugins;
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
      expect(pending()).toEqual(
        inactive || pendingState ? beforePending : retainsOther ? [unrelated] : [],
      );
      expect(await records()).toEqual(expectedNextRecords);
      if (inactive) {
        expect(plugins.entries[pluginId].enabled).toBe(false);
      }
      if (scenario === "partial-update") {
        expect(fs.existsSync(unselectedMarker)).toBe(false);
      }
      if (pendingState) {
        expect(applyRuntime).not.toHaveBeenCalled();
        expect(log.mock.calls.flat().join("\n")).toContain("openclaw doctor --fix");
        expect(fs.existsSync(previousPath)).toBe(true);
      } else if (settled) {
        expect(configText()).toBe(beforeConfig);
        expect(log).not.toHaveBeenCalledWith(savedMessage);
      } else if (scenario !== "install-replacement" && scenario !== "disabled-install") {
        expect(log).toHaveBeenCalledWith(savedMessage);
      }
    },
  );
});
