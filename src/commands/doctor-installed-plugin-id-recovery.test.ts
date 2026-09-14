import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updatePluginsAfterCoreUpdate } from "../cli/update-cli/update-command-plugins.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveConfigWidePluginMetadataSnapshot } from "../config/io.plugin-metadata.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { copyPluginInstallRecordMap } from "../config/plugin-install-record-map.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  runInitialConfigWriteHealth,
  runWriteConfigHealth,
} from "../flows/doctor-health-contribution-runners.config.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import * as payloadVerification from "../plugins/active-payload-verification.js";
import { createManagedPluginArtifactConsentHandler } from "../plugins/capability-consent.js";
import { commitPluginInstallRecordsOnly } from "../plugins/install-record-commit.js";
import { withPluginInstallRoots } from "../plugins/install-root-context.js";
import { installPluginFromNpmSpec } from "../plugins/install.js";
import {
  readPersistedInstalledPluginIndexInstallRecords,
  withPluginInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../plugins/installed-plugin-index-records.js";
import { buildNpmResolutionInstallFields } from "../plugins/installs.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  packPlugins,
  startMutableRegistry,
} from "../plugins/test-helpers/npm-registry-fixtures.js";
import { updateNpmInstalledPlugins } from "../plugins/update.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { runStartupUpgradeConvergence } from "./doctor-config-preflight-plugin-verification.js";
import { runIsolatedModuleScript } from "./doctor-config-preflight.process.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { doctorConfigRuntimeEntrypoints } from "./doctor-config-runtime.test-support.js";
import {
  prepareDoctorConfigReferenceSource,
  restoreDoctorConfigEnvRefs,
} from "./doctor/shared/config-flow-steps.js";
import { recoverInstalledPluginConfigIds } from "./doctor/shared/installed-plugin-id-recovery.js";
import { runPostCorePluginConvergence } from "./doctor/shared/post-core-plugin-convergence.js";

const legacyId = "fish-audio";
const canonicalId = "fish-audio-speech";
const packageName = "@openclaw/fish-audio-speech";
const servers: http.Server[] = [];
const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  note.mockClear();
});

async function withRecoveredInstall(
  run: (fixture: {
    home: string;
    configPath: string;
    original: string;
    config: OpenClawConfig;
    configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
    records: Record<string, PluginInstallRecord>;
    requests: string[];
    updatedIntegrity: string;
  }) => Promise<void>,
  options: { speechProvider?: boolean; updateBeforeRun?: boolean } = {},
): Promise<void> {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    const userConfig = path.join(home, "npmrc");
    const globalConfig = path.join(home, "global.npmrc");
    await fs.writeFile(userConfig, "");
    await fs.writeFile(globalConfig, "");
    await fs.writeFile(path.join(home, "package.json"), '{"private":true}');
    const inheritedNpmConfig = Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => /^npm_config_/i.test(key))
        .map((key) => [key, undefined]),
    );
    await withEnvAsync(
      {
        ...inheritedNpmConfig,
        HOME: home,
        OPENCLAW_HOME: home,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        NPM_CONFIG_USERCONFIG: userConfig,
        npm_config_userconfig: userConfig,
        NPM_CONFIG_GLOBALCONFIG: globalConfig,
        npm_config_globalconfig: globalConfig,
        NPM_CONFIG_CACHE: path.join(home, "npm-cache"),
        npm_config_cache: path.join(home, "npm-cache"),
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        npm_config_update_notifier: "false",
        NPM_CONFIG_NOPROXY: "127.0.0.1,localhost",
        npm_config_noproxy: "127.0.0.1,localhost",
        PLUGIN_TOKEN: "original-token",
        LEGACY_PLUGIN: legacyId,
      },
      async () => {
        const manifest = options.speechProvider
          ? { contracts: { speechProviders: [legacyId] } }
          : {};
        const versions = await packPlugins(home, [
          { packageName, pluginId: legacyId, version: "2.0.0", manifest },
          {
            packageName,
            pluginId: canonicalId,
            version: "2.0.1",
            manifest: { ...manifest, legacyPluginIds: [legacyId] },
          },
        ]);
        const registry = await startMutableRegistry(
          { packageName, initialLatest: "2.0.0", laterLatest: "2.0.1", versions },
          servers,
        );
        const requests: string[] = [];
        servers.at(-1)?.on("request", (request) => requests.push(request.url ?? ""));
        await withEnvAsync(
          {
            NPM_CONFIG_REGISTRY: registry,
            npm_config_registry: registry,
            "npm_config_@openclaw:registry": registry,
          },
          () =>
            withPluginInstallRoots(
              {
                stateDir,
                extensionsDir: path.join(stateDir, "extensions"),
                npmDir: path.join(stateDir, "npm"),
                gitDir: path.join(stateDir, "git"),
              },
              async () => {
                const config: OpenClawConfig = {
                  agents: { entries: { main: { workspace: path.join(home, "workspace") } } },
                  gateway: { mode: "local" },
                  tools: { web: { search: { enabled: false }, fetch: { enabled: false } } },
                  logging: { level: "info", file: path.join(home, "doctor.log") },
                  plugins: {
                    allow: ["${LEGACY_PLUGIN}"],
                    entries: {
                      [legacyId]: {
                        enabled: true,
                        config: { apiKey: "${PLUGIN_TOKEN}", literal: "$${PLUGIN_TOKEN}" },
                      },
                    },
                  },
                };
                const configPath = await writeOpenClawConfig(home, config);
                const original = await fs.readFile(configPath, "utf8");
                const resolved = (await readConfigFileSnapshot({ skipPluginValidation: true }))
                  .sourceConfig;
                const spec = `${packageName}@latest`;
                const consent = createManagedPluginArtifactConsentHandler({
                  config: resolved,
                  env: process.env,
                  source: "npm",
                  spec,
                  onCapabilityConsent: async ({ reviewToken }) => ({ reviewToken }),
                });
                const installed = await installPluginFromNpmSpec({
                  config: resolved,
                  spec,
                  expectedPluginId: legacyId,
                  onBeforePluginArtifactCommit: consent.onBeforePluginArtifactCommit,
                });
                expect(installed.ok, JSON.stringify(installed)).toBe(true);
                if (!installed.ok) {
                  throw new Error(installed.error);
                }
                expect(installed.pluginId).toBe(legacyId);
                expect(installed.version).toBe("2.0.0");
                expect(installed.npmResolution?.resolvedSpec).toBe(`${packageName}@2.0.0`);
                expect(installed.npmResolution?.integrity).toBe(versions[0]?.integrity);
                const previous = {
                  [legacyId]: consent.applyAcceptedSurface(legacyId, {
                    source: "npm",
                    spec,
                    installPath: installed.targetDir,
                    version: installed.version,
                    ...buildNpmResolutionInstallFields(installed.npmResolution),
                  }),
                };
                await writePersistedInstalledPluginIndexInstallRecords(previous, {
                  config: resolved,
                });
                const configSnapshot = await readConfigFileSnapshot();
                expect(configSnapshot.valid, JSON.stringify(configSnapshot.issues)).toBe(true);
                let records: Record<string, PluginInstallRecord> = previous;
                if (options.updateBeforeRun !== false) {
                  const updated = await updateNpmInstalledPlugins({
                    config: withPluginInstallRecords(resolved, previous),
                    pluginIds: [legacyId],
                    onCapabilityConsent: async ({ reviewToken }) => ({ reviewToken }),
                  });
                  expect(updated.outcomes).toContainEqual(
                    expect.objectContaining({ pluginId: legacyId, status: "updated" }),
                  );
                  const updatedRecords = updated.config.plugins?.installs;
                  expect(updatedRecords?.[canonicalId]?.version).toBe("2.0.1");
                  expect(updatedRecords?.[canonicalId]?.integrity).toBe(versions[1]?.integrity);
                  expect(updatedRecords).not.toHaveProperty(legacyId);
                  if (!updatedRecords) {
                    throw new Error("Expected the real updater's canonical records");
                  }
                  records = updatedRecords;
                  // The real record owner commits independently of the later Doctor config write.
                  await commitPluginInstallRecordsOnly({
                    previousInstallRecords: previous,
                    nextInstallRecords: records,
                    nextConfig: updated.config,
                  });
                }
                expect(readPersistedInstalledPluginIndexInstallRecords()).toStrictEqual(
                  copyPluginInstallRecordMap(records),
                );
                expect(await fs.readFile(configPath, "utf8")).toBe(original);
                clearPluginMetadataLifecycleCaches();
                requests.length = 0;
                await run({
                  home,
                  configPath,
                  original,
                  config: resolved,
                  configSnapshot,
                  records,
                  requests,
                  updatedIntegrity: expectDefined(versions[1], "packed canonical fixture version")
                    .integrity,
                });
              },
            ),
        );
      },
    );
  });
}

describe("Doctor installed plugin id recovery", () => {
  it(
    "recovers in a fresh process after a refused config write, then remains idempotent",
    { timeout: 180_000 },
    async () => {
      await withRecoveredInstall(async ({ configPath, original, records, requests }) => {
        const ctx = await prepareDoctorContext(configPath);
        expect(ctx.cfg.plugins?.entries).not.toHaveProperty(legacyId);
        expect(ctx.cfg.plugins?.entries?.[canonicalId]?.config?.apiKey).toBe("original-token");
        const concurrent = JSON.stringify({
          ...JSON.parse(original),
          logging: { level: "debug" },
        });
        await fs.writeFile(configPath, concurrent);
        note.mockClear();
        await runInitialConfigWriteHealth(ctx);
        expect(ctx.configWriteRefusal).toBe("config-conflict");
        expect(note.mock.calls.some(([, title]) => title === "Doctor changes")).toBe(false);
        expect(await fs.readFile(configPath, "utf8")).toBe(concurrent);
        expect(readPersistedInstalledPluginIndexInstallRecords()).toStrictEqual(
          copyPluginInstallRecordMap(records),
        );
        const flowUrl = resolveRuntimeWorkerUrl(doctorConfigRuntimeEntrypoints.configFlow).href;
        const healthUrl = resolveRuntimeWorkerUrl(doctorConfigRuntimeEntrypoints.configHealth).href;
        const script = `
        const { loadAndMaybeMigrateDoctorConfig } = await import(${JSON.stringify(flowUrl)});
        const { runInitialConfigWriteHealth, runWriteConfigHealth } = await import(${JSON.stringify(healthUrl)});
        const options = { nonInteractive: true, repair: true };
        const runtime = { log() {}, error() {}, exit(code) { throw new Error("exit " + code); } };
        const configResult = await loadAndMaybeMigrateDoctorConfig({
          options, runtime, confirm: async () => true,
        });
        const ctx = {
          options, runtime, configResult,
          prompter: { shouldRepair: true },
          cfg: configResult.cfg, cfgForPersistence: structuredClone(configResult.cfg),
          configPath: ${JSON.stringify(configPath)}, stateDirExistedAtStart: true,
          sourceConfigValid: configResult.sourceConfigValid ?? true,
        };
        await runInitialConfigWriteHealth(ctx);
        await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
        if (ctx.configWriteRefusal) throw new Error(ctx.configWriteRefusal);
      `;
        await runIsolatedModuleScript({ ...process.env, PLUGIN_TOKEN: "rotated-token" }, script, {
          timeoutMs: 60_000,
        });
        const saved = await fs.readFile(configPath, "utf8");
        const parsed = JSON.parse(saved);
        expect(parsed.plugins.entries).not.toHaveProperty(legacyId);
        expect(parsed.plugins.entries[canonicalId].config).toStrictEqual({
          apiKey: "${PLUGIN_TOKEN}",
          literal: "$${PLUGIN_TOKEN}",
        });
        expect(parsed.plugins.allow).toStrictEqual([canonicalId]);
        expect(parsed.logging.level).toBe("debug");
        await withEnvAsync({ PLUGIN_TOKEN: "rotated-token" }, async () => {
          const reread = await readConfigFileSnapshot();
          expect(reread.sourceConfig.plugins?.entries?.[canonicalId]?.config).toStrictEqual({
            apiKey: "rotated-token",
            literal: "${PLUGIN_TOKEN}",
          });
        });
        expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(concurrent);
        await runIsolatedModuleScript({ ...process.env, PLUGIN_TOKEN: "third-token" }, script, {
          timeoutMs: 60_000,
        });
        expect(await fs.readFile(configPath, "utf8")).toBe(saved);
        expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(concurrent);
        expect(readPersistedInstalledPluginIndexInstallRecords()).toStrictEqual(
          copyPluginInstallRecordMap(records),
        );
        expect(requests).toStrictEqual([]);
      });
    },
  );

  it(
    "keeps canonical precedence and policy ids while restoring only moved references",
    { timeout: 120_000 },
    async () => {
      await withRecoveredInstall(async ({ configPath, original }) => {
        const authored = JSON.parse(original);
        authored.plugins.deny = ["${LEGACY_PLUGIN}"];
        authored.plugins.entries[legacyId].enabled = false;
        authored.plugins.entries[canonicalId] = { config: { apiKey: "${CANONICAL_TOKEN}" } };
        await fs.writeFile(configPath, JSON.stringify(authored));
        await withEnvAsync({ CANONICAL_TOKEN: "original-token" }, async () => {
          const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
          const source = prepareDoctorConfigReferenceSource(snapshot);
          expect(source).toBeDefined();
          if (!source) {
            throw new Error("Expected authored planning provenance");
          }
          const before = structuredClone(source);
          const recovered = await recoverInstalledPluginConfigIds(
            snapshot.sourceConfig,
            process.env,
          );
          source.installedPluginIdRecovery = recovered.recovery;
          expect(recovered.config.plugins?.deny).toStrictEqual([canonicalId]);
          expect(recovered.config.plugins?.entries?.[canonicalId]).toStrictEqual({
            enabled: false,
            config: { apiKey: "original-token" },
          });
          const restored = restoreDoctorConfigEnvRefs(recovered.config, source);
          expect(restored.plugins?.entries?.[canonicalId]?.config).toStrictEqual({
            apiKey: "${CANONICAL_TOKEN}",
          });
          expect(restored.plugins?.allow).toStrictEqual([canonicalId]);
          expect(restored.plugins?.deny).toStrictEqual([canonicalId]);
          expect(source.authored).toStrictEqual(before.authored);
          expect(source.resolved).toStrictEqual(before.resolved);
        });
      });
    },
  );

  it.each([false, true])(
    "migrates authored disable policy before speech auto-enable (explicit canonical enable=%s)",
    { timeout: 120_000 },
    async (canonicalEnabled) => {
      await withRecoveredInstall(
        async ({ configPath, original }) => {
          const authored = JSON.parse(original);
          authored.tts = { provider: legacyId };
          authored.plugins.entries[legacyId].enabled = false;
          if (canonicalEnabled) {
            authored.plugins.entries[canonicalId] = { enabled: true };
          }
          await fs.writeFile(configPath, JSON.stringify(authored));
          const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
          const activated = applyPluginAutoEnable({
            config: snapshot.sourceConfig,
            env: process.env,
          });
          expect(activated.config.plugins?.entries?.[canonicalId]?.enabled).toBe(true);

          const ctx = await prepareDoctorContext(configPath);
          expect(ctx.cfg.plugins?.entries).not.toHaveProperty(legacyId);
          expect(ctx.cfg.plugins?.entries?.[canonicalId]?.enabled).toBe(canonicalEnabled);
          expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
          const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
          expect(saved.plugins.entries[canonicalId].enabled).toBe(canonicalEnabled);
          expect(saved.plugins.entries[canonicalId].config).toStrictEqual({
            apiKey: "${PLUGIN_TOKEN}",
            literal: "$${PLUGIN_TOKEN}",
          });
        },
        { speechProvider: true },
      );
    },
  );

  it(
    "does not fence an unrelated nested include write for an already-canonical installation",
    { timeout: 120_000 },
    async () => {
      await withRecoveredInstall(async ({ configPath, original }) => {
        const authored = JSON.parse(original);
        authored.plugins.allow = [canonicalId];
        authored.plugins.entries[canonicalId] = authored.plugins.entries[legacyId];
        delete authored.plugins.entries[legacyId];
        await fs.writeFile(configPath, JSON.stringify(authored));
        const first = await prepareDoctorContext(configPath);
        await runInitialConfigWriteHealth(first);
        expect(first.configWriteRefusal).toBeUndefined();
        const settled = JSON.parse(await fs.readFile(configPath, "utf8"));
        const directory = path.dirname(configPath);
        const parentPath = path.join(directory, "browser.json");
        const leafPath = path.join(directory, "browser-settings.json");
        const parentBytes = '{"$include":"./browser-settings.json"}\n';
        const leafBytes = '{"enabled":false,"actionTimeoutMs":5000}\n';
        await fs.writeFile(parentPath, parentBytes);
        await fs.writeFile(leafPath, leafBytes);
        await fs.writeFile(
          configPath,
          JSON.stringify({ ...settled, browser: { $include: "./browser.json" } }),
        );
        const rootBytes = await fs.readFile(configPath, "utf8");
        const ctx = await prepareDoctorContext(configPath);
        expect(ctx.configResult.shouldWriteConfig).toBe(true);
        expect(ctx.configResult.skipWizardMetadataForIncludeWrite).toBe(true);
        expect(ctx.configResult.referenceSource?.installedPluginIdRecovery?.size).toBe(0);
        expect(
          await runWriteConfigHealth(ctx, { runPostWriteRepairs: false }),
          JSON.stringify({
            refusal: ctx.configWriteRefusal,
            shouldWriteConfig: ctx.configResult.shouldWriteConfig,
            skipWizardMetadataForIncludeWrite: ctx.configResult.skipWizardMetadataForIncludeWrite,
          }),
        ).toBe(true);
        expect(await fs.readFile(configPath, "utf8")).toBe(rootBytes);
        expect(await fs.readFile(parentPath, "utf8")).toBe(parentBytes);
        expect(JSON.parse(await fs.readFile(leafPath, "utf8"))).toStrictEqual({ enabled: false });
        expect(await fs.readFile(`${leafPath}.bak`, "utf8")).toBe(leafBytes);
      });
    },
  );

  it(
    "preserves planning references across successive include-aware writes and later drift refusal",
    { timeout: 120_000 },
    async () => {
      await withRecoveredInstall(async ({ configPath, original, records }) => {
        const includePath = path.join(path.dirname(configPath), "browser.json");
        const includeBytes = '{"enabled":false,"executablePath":"${BROWSER_BIN}"}\n';
        await fs.writeFile(includePath, includeBytes);
        const authored = { ...JSON.parse(original), browser: { $include: "./browser.json" } };
        await fs.writeFile(configPath, JSON.stringify(authored));
        await withEnvAsync({ BROWSER_BIN: "/opt/example/old-browser" }, async () => {
          const ctx = await prepareDoctorContext(configPath);
          await withEnvAsync(
            { PLUGIN_TOKEN: "later-token", BROWSER_BIN: "/opt/example/new-browser" },
            async () => {
              expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
              expect(
                JSON.parse(await fs.readFile(configPath, "utf8")).plugins.entries[canonicalId]
                  .config,
              ).toStrictEqual({ apiKey: "${PLUGIN_TOKEN}", literal: "$${PLUGIN_TOKEN}" });
              expect(await fs.readFile(includePath, "utf8")).toBe(includeBytes);
              const reread = await readConfigFileSnapshot();
              expect(reread.sourceConfig.plugins?.entries?.[canonicalId]?.config?.apiKey).toBe(
                "later-token",
              );
              expect(reread.sourceConfig.browser?.executablePath).toBe("/opt/example/new-browser");
              ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, bind: "lan" } };
              expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
              const committed = await fs.readFile(configPath, "utf8");
              const backup = await fs.readFile(`${configPath}.bak`, "utf8");
              const receipt = structuredClone(ctx.configResult.confirmedConfigSource);
              const baseline = structuredClone(ctx.cfgForPersistence);
              await fs.writeFile(includePath, `${includeBytes}\n`);
              ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, port: 18790 } };
              expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(false);
              expect(await fs.readFile(configPath, "utf8")).toBe(committed);
              expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(backup);
              expect(await fs.readFile(includePath, "utf8")).toBe(`${includeBytes}\n`);
              expect(ctx.configResult.confirmedConfigSource).toStrictEqual(receipt);
              expect(ctx.cfgForPersistence).toStrictEqual(baseline);
              expect(readPersistedInstalledPluginIndexInstallRecords()).toStrictEqual(
                copyPluginInstallRecordMap(records),
              );
            },
          );
        });
      });
    },
  );

  it.each([
    "old-record",
    "local-old-owner",
    "disabled-local-old-owner",
    "global-old-owner",
    "bundled-old-owner",
    "local-canonical-owner",
    "competing-claim",
    "workspace-conflict",
    "invalid-installed-provenance",
  ] as const)(
    "preserves the old config when recovery sees %s",
    { timeout: 120_000 },
    async (scenario) => {
      await withRecoveredInstall(async ({ home, config, records }) => {
        expect(
          (await recoverInstalledPluginConfigIds(config, process.env)).recovery.has(legacyId),
        ).toBe(true);
        let next = config;
        if (scenario === "old-record") {
          await writePersistedInstalledPluginIndexInstallRecords(
            {
              ...records,
              [legacyId]: { source: "path", sourcePath: path.join(home, "old-owner") },
            },
            { config },
          );
        } else if (scenario === "invalid-installed-provenance") {
          await writePersistedInstalledPluginIndexInstallRecords(
            {
              ...records,
              [canonicalId]: {
                ...records[canonicalId],
                source: "npm",
                spec: "@example/not-official@2.0.1",
                resolvedName: "@example/not-official",
                resolvedSpec: "@example/not-official@2.0.1",
              },
            },
            { config },
          );
          const snapshot = resolveConfigWidePluginMetadataSnapshot({
            config,
            env: process.env,
            allowCurrent: false,
            installRecords: expectDefined(
              readPersistedInstalledPluginIndexInstallRecords(),
              "persisted invalid-provenance fixture records",
            ),
          });
          const claimants = snapshot.plugins.filter((plugin) =>
            plugin.legacyPluginIds?.includes(legacyId),
          );
          expect(claimants.map((plugin) => plugin.id)).toStrictEqual([canonicalId]);
          expect(claimants[0]?.trustedOfficialInstall).not.toBe(true);
        } else {
          const roots =
            scenario === "workspace-conflict"
              ? [path.join(home, "first"), path.join(home, "second")]
              : scenario === "global-old-owner"
                ? [path.join(home, ".openclaw", "extensions", "retained-owner")]
                : scenario === "bundled-old-owner"
                  ? [path.join(home, "bundled", "retained-owner")]
                  : [path.join(home, "local")];
          const paths: string[] = [];
          for (const root of roots) {
            const directory =
              scenario === "workspace-conflict"
                ? path.join(root, ".openclaw", "extensions", "local-owner")
                : root;
            await fs.mkdir(directory, { recursive: true });
            await fs.writeFile(
              path.join(directory, "package.json"),
              JSON.stringify({
                name: "@example/local-owner",
                version: "1.0.0",
                openclaw: { extensions: ["./index.js"] },
              }),
            );
            await fs.writeFile(path.join(directory, "index.js"), "export {};");
            await fs.writeFile(
              path.join(directory, "openclaw.plugin.json"),
              JSON.stringify({
                id:
                  scenario === "local-canonical-owner"
                    ? canonicalId
                    : scenario === "competing-claim"
                      ? "competing-owner"
                      : legacyId,
                legacyPluginIds: scenario === "competing-claim" ? [legacyId] : [],
                configSchema: { type: "object" },
              }),
            );
            paths.push(directory);
          }
          next =
            scenario === "workspace-conflict"
              ? {
                  ...config,
                  agents: {
                    entries: {
                      first: { workspace: roots[0] },
                      second: { workspace: roots[1] },
                    },
                  },
                }
              : scenario === "global-old-owner" || scenario === "bundled-old-owner"
                ? config
                : {
                    ...config,
                    plugins: {
                      ...config.plugins,
                      load: { paths },
                      ...(scenario === "disabled-local-old-owner"
                        ? {
                            entries: {
                              ...config.plugins?.entries,
                              [legacyId]: {
                                ...config.plugins?.entries?.[legacyId],
                                enabled: false,
                              },
                            },
                          }
                        : {}),
                    },
                  };
        }
        await withEnvAsync(
          scenario === "bundled-old-owner"
            ? {
                OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
                OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(home, "bundled"),
                OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
              }
            : {},
          async () => {
            if (scenario === "global-old-owner" || scenario === "bundled-old-owner") {
              const snapshot = resolveConfigWidePluginMetadataSnapshot({
                config: next,
                env: process.env,
                allowCurrent: false,
                installRecords: expectDefined(
                  readPersistedInstalledPluginIndexInstallRecords(),
                  "persisted retained-owner fixture records",
                ),
              });
              expect(snapshot.byPluginId.get(legacyId)?.origin).toBe(
                scenario === "global-old-owner" ? "global" : "bundled",
              );
            }
            const recovered = await recoverInstalledPluginConfigIds(next, process.env);
            expect(recovered.config).toBe(next);
            expect(recovered.recovery.has(legacyId)).toBe(false);
            expect(recovered.preservePluginIds).toContain(legacyId);
          },
        );
      });
    },
  );

  it(
    "refuses ownership drift after planning and keeps the committed package and config bytes",
    { timeout: 120_000 },
    async () => {
      await withRecoveredInstall(async ({ configPath, original, records }) => {
        const ctx = await prepareDoctorContext(configPath);
        const record = records[canonicalId];
        expect(record?.installPath).toBeDefined();
        if (!record?.installPath) {
          throw new Error("Expected the committed plugin payload");
        }
        const manifestPath = path.join(record.installPath, "openclaw.plugin.json");
        const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
        await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, legacyPluginIds: [] }));
        note.mockClear();
        await runInitialConfigWriteHealth(ctx);
        expect(ctx.configWriteRefusal).toBe("config-conflict");
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
        expect(note.mock.calls.some(([, title]) => title === "Doctor changes")).toBe(false);
        expect(readPersistedInstalledPluginIndexInstallRecords()).toStrictEqual(
          copyPluginInstallRecordMap(records),
        );
      });
    },
  );

  it(
    "passes the recovered config to real post-core smoke without reporting it as persisted",
    { timeout: 120_000 },
    async () => {
      await withRecoveredInstall(async ({ configPath, original, config, records }) => {
        const smoke = vi.spyOn(payloadVerification, "runActivePluginPayloadSmokeCheck");
        const result = await runPostCorePluginConvergence({
          cfg: config,
          configPersistence: "caller",
          env: process.env,
          baselineInstallRecords: records,
        });
        expect(result.config.plugins?.entries).not.toHaveProperty(legacyId);
        expect(smoke).toHaveBeenCalledWith(expect.objectContaining({ cfg: result.config }));
        expect(result.config.plugins?.allow).toStrictEqual([canonicalId]);
        expect(result.config.plugins?.entries?.[canonicalId]?.config).toStrictEqual({
          apiKey: "original-token",
          literal: "${PLUGIN_TOKEN}",
        });
        expect(result.smokeFailures).toStrictEqual([]);
        expect(result.configChanges).toContain(
          `Moved installed plugin config "${legacyId}" to "${canonicalId}".`,
        );
        expect(result.changes).not.toContain(result.configChanges[0]);
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
      });
    },
  );

  it(
    "lets startup verify a healthy retained legacy owner without adopting an unpersisted rename",
    { timeout: 120_000 },
    async () => {
      await withRecoveredInstall(async ({ home, configPath, original, records }) => {
        const rootDir = path.join(home, "retained-owner");
        await fs.mkdir(rootDir);
        createColdPluginFixture({
          rootDir,
          pluginId: legacyId,
          manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
        });
        const authored = JSON.parse(original);
        authored.plugins.load = { paths: [rootDir] };
        const retainedBytes = JSON.stringify(authored);
        await fs.writeFile(configPath, retainedBytes);
        const cfg = (await readConfigFileSnapshot()).sourceConfig;
        const smoke = vi.spyOn(payloadVerification, "runActivePluginPayloadSmokeCheck");
        const planned = await runPostCorePluginConvergence({
          cfg,
          configPersistence: "caller",
          env: process.env,
          baselineInstallRecords: records,
        });
        expect(planned.config).toBe(cfg);
        expect(planned.configChanges).toStrictEqual([]);
        expect(planned.warnings).toStrictEqual([]);
        expect(planned.notices).toContainEqual(
          expect.objectContaining({
            message: expect.stringContaining(`Kept plugin config "${legacyId}"`),
          }),
        );
        expect(await runStartupUpgradeConvergence({ cfg, env: process.env })).toStrictEqual({
          blockingDiagnostic: null,
          quarantinedPlugins: [],
        });
        expect(smoke).toHaveBeenLastCalledWith(expect.objectContaining({ cfg }));
        expect(cfg.plugins?.entries?.[legacyId]?.enabled).toBe(true);
        expect(cfg.plugins?.entries).not.toHaveProperty(canonicalId);
        expect(await fs.readFile(configPath, "utf8")).toBe(retainedBytes);
      });
    },
  );

  it(
    "recovers a committed replacement while preserving an ordinary failed sibling",
    { timeout: 120_000 },
    async () => {
      await withRecoveredInstall(async ({ home, configPath, original, records, requests }) => {
        const failedId = "failed-sibling";
        const failedRecord: PluginInstallRecord = {
          source: "npm",
          spec: "@openclaw/failed-sibling@1.0.0",
          version: "1.0.0",
          installPath: path.join(home, "missing-sibling"),
          resolvedName: "@openclaw/failed-sibling",
          resolvedVersion: "1.0.0",
          resolvedSpec: "@openclaw/failed-sibling@1.0.0",
        };
        const authored = JSON.parse(original);
        authored.plugins.allow.push(failedId);
        authored.plugins.entries[failedId] = {
          enabled: true,
          config: { apiKey: "${PLUGIN_TOKEN}" },
        };
        await fs.writeFile(configPath, JSON.stringify(authored));
        const expectedRecords = { ...records, [failedId]: failedRecord };
        await writePersistedInstalledPluginIndexInstallRecords(expectedRecords);

        const ctx = await prepareDoctorContext(configPath);
        expect(
          requests.some((url) => decodeURIComponent(url).includes("/@openclaw/failed-sibling")),
        ).toBe(true);
        expect(
          note.mock.calls.some(
            ([message, title]) => title === "Doctor warnings" && message.includes(failedId),
          ),
        ).toBe(true);
        expect(ctx.cfg.plugins?.entries).not.toHaveProperty(legacyId);
        expect(ctx.cfg.plugins?.entries?.[canonicalId]?.config?.apiKey).toBe("original-token");
        expect(ctx.cfg.plugins?.entries?.[failedId]).toStrictEqual({
          enabled: true,
          config: { apiKey: "original-token" },
        });
        expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
        const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(saved.plugins.entries[canonicalId].config.apiKey).toBe("${PLUGIN_TOKEN}");
        expect(saved.plugins.entries[failedId]).toStrictEqual(authored.plugins.entries[failedId]);
        expect(readPersistedInstalledPluginIndexInstallRecords()).toStrictEqual(
          copyPluginInstallRecordMap(expectedRecords),
        );
      });
    },
  );

  it.each(["ordinary", "escaped", "canonical-collision"] as const)(
    "preserves %s references through a same-invocation cohort rename",
    { timeout: 120_000 },
    async (scenario) => {
      await withRecoveredInstall(
        async ({ home, configPath, original, records, updatedIntegrity }) => {
          expect(Object.keys(records)).toStrictEqual([legacyId]);
          expect(records[legacyId]?.version).toBe("2.0.0");
          const authored = JSON.parse(original);
          const legacyReference = scenario === "escaped" ? "$${PLUGIN_TOKEN}" : "${PLUGIN_TOKEN}";
          authored.plugins.entries[legacyId].config = { apiKey: legacyReference };
          if (scenario === "canonical-collision") {
            authored.plugins.entries[canonicalId] = {
              config: { apiKey: "${CANONICAL_TOKEN}" },
            };
          }
          const originalBytes = JSON.stringify(authored);
          await fs.writeFile(configPath, originalBytes);
          await withEnvAsync({ CANONICAL_TOKEN: "original-token" }, async () => {
            const configSnapshot = await readConfigFileSnapshot();
            expect(configSnapshot.valid, JSON.stringify(configSnapshot.issues)).toBe(true);
            const result = await updatePluginsAfterCoreUpdate({
              root: home,
              channel: "stable",
              configSnapshot,
              configWriteOptions: {},
              pluginInstallRecords: records,
              timeoutMs: 60_000,
              onCapabilityConsent: async ({ reviewToken }) => ({ reviewToken }),
              runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
            });
            expect(result.integrityDrifts).toStrictEqual([]);
            expect(result.npm.outcomes).toContainEqual(
              expect.objectContaining({
                pluginId: legacyId,
                status: "updated",
                currentVersion: "2.0.0",
                nextVersion: "2.0.1",
              }),
            );
            const committedRecords = expectDefined(
              readPersistedInstalledPluginIndexInstallRecords(),
              "same-invocation updater's committed records",
            );
            expect(committedRecords).not.toHaveProperty(legacyId);
            const canonicalRecord = committedRecords[canonicalId];
            expect(canonicalRecord?.resolvedSpec).toBe(`${packageName}@2.0.1`);
            expect(canonicalRecord?.version).toBe("2.0.1");
            if (!canonicalRecord?.installPath) {
              throw new Error("Expected the same-invocation updater to commit the canonical owner");
            }
            expect(canonicalRecord.source).toBe("npm");
            expect(canonicalRecord.resolvedName).toBe(packageName);
            expect(canonicalRecord.resolvedVersion).toBe("2.0.1");
            expect(canonicalRecord.integrity).toBe(updatedIntegrity);
            const installedPackage = JSON.parse(
              await fs.readFile(path.join(canonicalRecord.installPath, "package.json"), "utf8"),
            );
            expect(installedPackage.name).toBe(packageName);
            expect(installedPackage.version).toBe("2.0.1");
            const manifest = JSON.parse(
              await fs.readFile(
                path.join(canonicalRecord.installPath, "openclaw.plugin.json"),
                "utf8",
              ),
            );
            expect(manifest.id).toBe(canonicalId);
            expect(manifest.legacyPluginIds).toStrictEqual([legacyId]);
            const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
            expect(saved.plugins.entries).not.toHaveProperty(legacyId);
            expect(saved.plugins.allow).toStrictEqual([canonicalId]);
            expect(saved.plugins.entries[canonicalId].config).toStrictEqual({
              apiKey: scenario === "canonical-collision" ? "${CANONICAL_TOKEN}" : legacyReference,
            });
            expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(originalBytes);
            await withEnvAsync(
              { PLUGIN_TOKEN: "rotated-token", CANONICAL_TOKEN: "canonical-rotated-token" },
              async () => {
                const reread = await readConfigFileSnapshot();
                expect(reread.sourceConfig.plugins?.entries?.[canonicalId]?.config?.apiKey).toBe(
                  scenario === "canonical-collision"
                    ? "canonical-rotated-token"
                    : scenario === "escaped"
                      ? "${PLUGIN_TOKEN}"
                      : "rotated-token",
                );
              },
            );
          });
        },
        { updateBeforeRun: false },
      );
    },
  );

  it.each(["commits", "refuses", "lease-revoked"] as const)(
    "%s the final updater config write without losing committed identity or authored references",
    { timeout: 120_000 },
    async (outcome) => {
      await withRecoveredInstall(
        async ({ home, configPath, original, configSnapshot, records }) => {
          const record = records[canonicalId];
          if (!record?.installPath) {
            throw new Error("Expected the committed canonical payload");
          }
          const packagePath = path.join(record.installPath, "package.json");
          const packageBytes = await fs.readFile(packagePath, "utf8");
          const concurrent = JSON.stringify({
            ...JSON.parse(original),
            logging: { level: "debug" },
          });
          if (outcome === "refuses") {
            await fs.writeFile(configPath, concurrent);
          }
          const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          const controller = new AbortController();
          const beforeCommit = vi.fn(() => {
            if (outcome === "lease-revoked") {
              controller.abort(new Error("fixture writer revoked"));
            }
          });
          const migrationNote = `Moved installed plugin config "${legacyId}" to "${canonicalId}".`;
          await withEnvAsync({ PLUGIN_TOKEN: "updater-token" }, async () => {
            const runUpdate = () =>
              updatePluginsAfterCoreUpdate({
                root: home,
                channel: "stable",
                configSnapshot,
                configWriteOptions: { beforeCommit },
                pluginInstallRecords: records,
                timeoutMs: 60_000,
                onCapabilityConsent: async ({ reviewToken }) => ({ reviewToken }),
                runtime,
              });
            const update =
              outcome === "lease-revoked"
                ? withPluginLifecycleLease({ signal: controller.signal }, runUpdate)
                : runUpdate();
            if (outcome !== "commits") {
              if (outcome === "lease-revoked") {
                await expect(update).rejects.toMatchObject({
                  code: "OPENCLAW_STATE_LEASE_ABORTED",
                });
                expect(beforeCommit).toHaveBeenCalledOnce();
              } else {
                await expect(update).rejects.toThrow(/changed|conflict/i);
              }
              expect(await fs.readFile(configPath, "utf8")).toBe(
                outcome === "refuses" ? concurrent : original,
              );
              expect(
                runtime.log.mock.calls.some(([message]) => message.includes(migrationNote)),
              ).toBe(false);
            } else {
              await update;
              const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
              expect(saved.plugins.entries).not.toHaveProperty(legacyId);
              expect(saved.plugins.entries[canonicalId].config).toStrictEqual({
                apiKey: "${PLUGIN_TOKEN}",
                literal: "$${PLUGIN_TOKEN}",
              });
              expect(saved.plugins.allow).toStrictEqual([canonicalId]);
              expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(original);
              expect(
                runtime.log.mock.calls.some(([message]) => message.includes(migrationNote)),
              ).toBe(true);
            }
          });
          expect(await fs.readFile(packagePath, "utf8")).toBe(packageBytes);
          expect(readPersistedInstalledPluginIndexInstallRecords()).toStrictEqual(
            copyPluginInstallRecordMap(records),
          );
        },
      );
    },
  );
});
