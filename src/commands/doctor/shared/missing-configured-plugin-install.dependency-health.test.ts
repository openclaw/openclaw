// Register suite mocks before imports that read the install catalog.
import "./missing-configured-plugin-install.suite.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { PluginCapabilityConsentHandler } from "../../../plugins/capability-consent.js";
import { requestDeferredPluginInstall } from "../../../plugins/install-transaction.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../../../plugins/install-types.js";
import { readPersistedInstalledPluginIndex } from "../../../plugins/installed-plugin-index-store.js";
import {
  hasRetainedManagedNpmInstallMarker,
  markRetainedManagedNpmInstall,
  resolveRetainedManagedNpmInstallMarkerPath,
} from "../../../plugins/managed-npm-retention.js";
import { createPluginManifestRecordFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { createColdPluginFixture } from "../../../plugins/test-helpers/cold-plugin-fixtures.js";
import { seedInstalledPluginIndex } from "../../../plugins/test-helpers/installed-plugin-index.js";
import { writePluginJson } from "./missing-configured-plugin-install.fixtures.test-support.js";
import { officialPluginEntry } from "./missing-configured-plugin-install.test-helpers.js";

const {
  expectedIndexWriteOptions,
  mockCurrentBundledPlugin,
  repairConfiguredPlugins,
  useRealInstallIndexWrites,
  mocks,
  testEnv,
  tempDirs,
  setupPluginInstallSuite,
} = await import("./missing-configured-plugin-install.suite.test-support.js");

const writeRecords = mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease;
const updater = mocks.updateNpmInstalledPlugins;
const npmInstaller = mocks.installPluginFromNpmSpec;
const {
  configuredPluginInstallIssueToHealthFinding: healthFinding,
  configuredPluginInstallIssueToRepairEffect: repairEffect,
  detectConfiguredPluginInstallHealthIssues: detectHealth,
  repairMissingPluginInstallsForIds: repairInstalls,
} = await import("./missing-configured-plugin-install.js");

function mockInstalledPlugins(records: unknown, plugins: unknown[]) {
  mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
  mocks.loadPluginMetadataSnapshot.mockReturnValue({ plugins, diagnostics: [] });
}

function expectNoPackageEffects() {
  for (const effect of [updater, npmInstaller, writeRecords]) {
    expect(effect).not.toHaveBeenCalled();
  }
}

function readPayload(root: string, files = ["package.json", "openclaw.plugin.json", "index.cjs"]) {
  return files.map((file) => fs.readFileSync(path.join(root, file), "utf8"));
}

function configuredPlugins(...pluginIds: string[]): OpenClawConfig {
  return {
    plugins: { entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])) },
  };
}

function expectPublished(records: unknown, cfg: OpenClawConfig, env = testEnv) {
  expect(writeRecords).toHaveBeenCalledWith(records, expectedIndexWriteOptions(cfg, env));
}

function refuseMarkerCleanup(markerPath: string, failure: Error) {
  const rm = fs.promises.rm.bind(fs.promises);
  vi.spyOn(fs.promises, "rm").mockImplementation((file, options) =>
    file === markerPath ? Promise.reject(failure) : rm(file, options),
  );
}

function createReplacement(rootDir: string, pluginId: string, packageName = pluginId) {
  fs.mkdirSync(rootDir, { recursive: true });
  createColdPluginFixture({ rootDir, pluginId, packageName });
}

function createDependencyInstall(
  rootDir: string,
  pluginId: string,
  options: {
    packageName?: string;
    packageVersion?: string;
    origin?: "global" | "bundled";
  } = {},
) {
  const packageName = options.packageName ?? pluginId;
  const plugin = createPluginManifestRecordFixture({
    id: pluginId,
    origin: "global",
    rootDir,
    source: path.join(rootDir, "index.cjs"),
    packageDependencies: { "required-runtime": "1.0.0" },
    ...options,
    packageName,
  });
  fs.mkdirSync(rootDir, { recursive: true });
  createColdPluginFixture({
    rootDir,
    pluginId,
    packageName,
    packageVersion: plugin.packageVersion,
    packageJson: {
      dependencies: plugin.packageDependencies,
      optionalDependencies: plugin.packageOptionalDependencies,
    },
  });
  const version = plugin.packageVersion ?? "1.0.0";
  const markerPath = resolveRetainedManagedNpmInstallMarkerPath(rootDir);
  return {
    plugin,
    pluginId,
    packageName,
    rootDir,
    markerPath,
    readMarker: () => fs.readFileSync(markerPath, "utf8"),
    isRetained: () => hasRetainedManagedNpmInstallMarker(rootDir),
    retain: () =>
      markRetainedManagedNpmInstall({
        packageDir: rootDir,
        pluginId,
        reason: "existing-owner",
      }),
    payload: readPayload(rootDir),
    record: {
      source: "npm" as const,
      spec: `${packageName}@${version}`,
      resolvedName: packageName,
      resolvedSpec: `${packageName}@${version}`,
      resolvedVersion: version,
      installPath: rootDir,
      version,
      integrity: "sha512-dependency-fixture",
    },
  };
}

setupPluginInstallSuite();
it.each([
  "missing",
  "resolved-spec",
  "symlink-root",
  "hoisted",
  "deferred",
  "different-root",
  "package-mismatch",
  "resolved-name-mismatch",
  "disabled",
  "globally-disabled",
  "denylisted",
  "allowlist-excluded",
  "path-source",
  "missing-spec",
  "invalid-spec",
  "unconfigured",
  "unrequested",
  "bundled",
] as const)("attributes %s dependency health to the active npm install only", async (scenario) => {
  const parent = tempDirs.make("openclaw-doctor-dependency-health-");
  const projectRoot = path.join(parent, "project");
  const rootDir = path.join(projectRoot, "node_modules", "dependency-plugin");
  const pluginId = "dependency-plugin";
  const packageName = pluginId;
  const { plugin } = createDependencyInstall(rootDir, pluginId, {
    packageName: scenario === "package-mismatch" ? "another-package" : packageName,
    origin: scenario === "bundled" ? "bundled" : "global",
  });
  const cfg = configuredPlugins(pluginId);
  const record = {
    source: scenario === "path-source" ? "path" : "npm",
    spec:
      scenario === "missing-spec"
        ? undefined
        : scenario === "invalid-spec"
          ? "file:../foreign"
          : `${packageName}@1.0.0`,
    resolvedSpec: scenario === "resolved-spec" ? `${packageName}@1.2.3` : undefined,
    resolvedName: scenario === "resolved-name-mismatch" ? "another-package" : packageName,
    installPath: rootDir,
  };
  if (scenario === "different-root") {
    record.installPath = path.join(parent, "recorded-copy");
    createReplacement(record.installPath, pluginId, packageName);
  } else if (scenario === "symlink-root") {
    record.installPath = path.join(parent, "linked-copy");
    fs.symlinkSync(rootDir, record.installPath, "junction");
  }
  if (scenario === "hoisted") {
    const availableDir = path.join(projectRoot, "node_modules", "required-runtime");
    fs.mkdirSync(availableDir, { recursive: true });
    writePluginJson(availableDir, "package.json", { name: "required-runtime", version: "1.0.0" });
  }
  const policy = new Map<string, OpenClawConfig["plugins"]>([
    ["unconfigured", {}],
    ["disabled", { entries: { [pluginId]: { enabled: false } } }],
    ["globally-disabled", { ...cfg.plugins, enabled: false }],
    ["denylisted", { ...cfg.plugins, deny: [pluginId] }],
    ["allowlist-excluded", { ...cfg.plugins, allow: ["different-plugin"] }],
  ]).get(scenario);
  cfg.plugins = policy ?? cfg.plugins;
  if (scenario === "bundled") {
    mockCurrentBundledPlugin(pluginId, packageName);
  }
  mockInstalledPlugins({ [pluginId]: record }, [plugin]);
  const env =
    scenario === "deferred"
      ? {
          ...testEnv,
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
        }
      : testEnv;
  if (scenario === "unrequested") {
    const beforePersistentEffect = vi.fn();
    const result = await repairInstalls({
      cfg,
      env,
      pluginIds: [],
      beforePersistentEffect,
    });
    expect(result.changes).toEqual([]);
    expect(result.records).toEqual({ [pluginId]: record });
    expect(beforePersistentEffect).not.toHaveBeenCalled();
    expect(updater).not.toHaveBeenCalled();
    expect(hasRetainedManagedNpmInstallMarker(rootDir)).toBe(false);
    return;
  }
  const issues = await detectHealth({ cfg, env });

  if (["missing", "resolved-spec", "symlink-root"].includes(scenario)) {
    expect(issues).toEqual([
      {
        kind: "missing-required-dependencies",
        pluginId,
        installPath: record.installPath,
        installSpec: scenario === "resolved-spec" ? "dependency-plugin@1.2.3" : record.spec,
        installSource: "npm",
        missingRequired: ["required-runtime"],
      },
    ]);
    const issue = expectDefined(issues[0], "dependency health issue");
    expect(healthFinding(issue)).toMatchObject({
      target: pluginId,
      source: "npm",
      message: expect.stringContaining("required-runtime"),
      fixHint: `Run \`openclaw plugins install npm:dependency-plugin@${scenario === "resolved-spec" ? "1.2.3" : "1.0.0"} --force\` to reinstall the configured plugin package.`,
    });
    expect(repairEffect(issue)).toMatchObject({
      kind: "package",
      action: "would-repair-configured-plugin-dependencies",
      dryRunSafe: false,
    });
  } else if (scenario === "deferred") {
    expect(issues).toEqual([
      { kind: "deferred-package-manager-repair", pluginId, installPath: record.installPath },
    ]);
    const result = await repairConfiguredPlugins(cfg, env);
    expect(result.deferredRepairDetails).toEqual([expect.stringContaining(pluginId)]);
    expect(hasRetainedManagedNpmInstallMarker(rootDir)).toBe(false);
  } else {
    expect(issues).toEqual([]);
  }
  expectNoPackageEffects();
});

it.each<[string, boolean?]>([
  ["updated"],
  ["unchanged"],
  ["stale-updated"],
  ["skipped"],
  ["consent-error"],
  ["metadata-error"],
  ["effect-refused"],
  ["cleanup-error"],
  ["mixed", true],
  ["updater-throw", true],
  ["persist-throw", true],
  ["partial-marker-write", true],
  ["second-effect-refused", true],
  ["transaction-owner-refused", true],
  ["cleanup-throw", true],
])("settles %s dependency repair (multiple=%s)", async (scenario, multiple = false) => {
  const parent = tempDirs.make("openclaw-doctor-dependency-repair-");
  const stale = ["stale-updated", "consent-error", "metadata-error"].includes(scenario);
  const preexisting = scenario === "stale-updated";
  const pluginIds = [
    stale ? "codex" : "dependency-a",
    ...(multiple ? ["dependency-b", "dependency-c"] : []),
  ];
  const fixtures = pluginIds.map((id) => {
    const packageName = id === "codex" ? "@openclaw/codex" : id;
    const version = id === "codex" ? "2026.9.1-beta.1" : "1.0.0";
    const fixture = createDependencyInstall(
      path.join(parent, id, "node_modules", packageName),
      id,
      {
        packageName,
        packageVersion: version,
      },
    );
    if (id === "codex") {
      fixture.record.spec = packageName;
    }
    return fixture;
  });
  const first = expectDefined(fixtures[0], "first dependency fixture");
  if (preexisting) {
    await first.retain();
  }
  if (multiple) {
    await expectDefined(fixtures[2], "preexisting dependency fixture").retain();
  }
  const markers = fixtures.map((fixture) =>
    fixture.isRetained() ? fixture.readMarker() : undefined,
  );
  const records = Object.fromEntries(fixtures.map((fixture) => [fixture.pluginId, fixture.record]));
  const originalRecords = structuredClone(records);
  const env = multiple ? testEnv : { ...testEnv, OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.2" };
  const cfg = configuredPlugins(...pluginIds);
  if (!multiple) {
    cfg.update = { channel: "beta" };
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue(
      fixtures.map(({ pluginId, record }) =>
        officialPluginEntry({ id: pluginId, npmSpec: record.spec }),
      ),
    );
  }
  mockInstalledPlugins(
    records,
    fixtures.map((fixture) => fixture.plugin),
  );
  if (stale) {
    const { resolveConfiguredPluginInstallContext } =
      await import("./missing-configured-plugin-install.candidates.js");
    const context = await resolveConfiguredPluginInstallContext({
      cfg,
      env,
      configuredPluginIds: new Set(pluginIds),
      configuredChannelIds: new Set(),
    });
    // Both reasons must apply to exercise stale-runtime/dependency precedence.
    expect(context.installedPluginIdsWithStaleVersionBoundRuntimePackages.has(first.pluginId)).toBe(
      true,
    );
    expect(context.installedPluginMissingRequiredDependencies.has(first.pluginId)).toBe(true);
  }
  const failure = new Error(`dependency repair ${scenario}`);
  const cleanupFailure = new Error("retention cleanup failed");
  const succeeded = ["updated", "unchanged", "stale-updated", "mixed"].includes(scenario);
  const updated = succeeded || scenario === "persist-throw";
  const status =
    scenario === "unchanged" || scenario === "skipped" ? scenario : updated ? "updated" : "error";
  const authorityRefused = ["second-effect-refused", "transaction-owner-refused"].includes(
    scenario,
  );
  const throws = (multiple && scenario !== "mixed") || scenario === "effect-refused";
  const errorCode = new Map([
    ["consent-error", PLUGIN_CAPABILITY_CONSENT_REQUIRED],
    ["metadata-error", PLUGIN_INSTALL_ERROR_CODE.NPM_METADATA_FAILURE],
  ]).get(scenario);
  if (scenario === "partial-marker-write") {
    const second = expectDefined(fixtures[1], "second dependency fixture");
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    vi.spyOn(fs.promises, "writeFile").mockImplementation(async (file, data, options) => {
      if (file === second.markerPath) {
        await writeFile(file, '{"partial":', options);
        throw failure;
      }
      return writeFile(file, data, options);
    });
  }
  if (scenario === "cleanup-throw" || scenario === "cleanup-error") {
    refuseMarkerCleanup(first.markerPath, cleanupFailure);
  }
  let transactionOwned = true;
  let markerAtRefusal: string | undefined;
  const beforePersistentEffect = vi.fn(async () => {
    if (!multiple && beforePersistentEffect.mock.calls.length === 1) {
      expect(first.isRetained()).toBe(preexisting);
    }
    if (scenario === "effect-refused") {
      throw failure;
    }
    if (beforePersistentEffect.mock.calls.length === 2 && authorityRefused) {
      markerAtRefusal = first.readMarker();
      if (scenario === "second-effect-refused") {
        throw failure;
      }
      transactionOwned = false;
    }
  });
  const replacementRecord = { ...first.record, installPath: path.join(parent, "replacement") };
  updater.mockImplementation(async () => {
    for (const fixture of fixtures) {
      expect(fixture.isRetained()).toBe(true);
    }
    if (scenario === "updater-throw" || scenario === "cleanup-throw") {
      throw failure;
    }
    if (updated) {
      createReplacement(replacementRecord.installPath, first.pluginId, first.packageName);
    }
    return {
      config: { plugins: { installs: { ...records, [first.pluginId]: replacementRecord } } },
      changed: updated,
      outcomes: fixtures.map(({ pluginId }) => ({
        pluginId,
        status: pluginId === first.pluginId ? status : "error",
        message: multiple ? `repair outcome for ${pluginId}` : failure.message,
        ...(errorCode ? { code: errorCode } : {}),
      })),
    };
  });
  if (scenario === "persist-throw") {
    writeRecords.mockRejectedValueOnce(failure);
  }
  const repair = () => {
    const params = {
      cfg,
      pluginIds,
      env,
      beforePersistentEffect,
      onCapabilityConsent: vi.fn<PluginCapabilityConsentHandler>(),
    };
    return repairInstalls(
      scenario === "transaction-owner-refused"
        ? requestDeferredPluginInstall(params, [], () => {
            if (!transactionOwned) {
              throw failure;
            }
          })
        : params,
    );
  };
  if (throws) {
    if (scenario === "cleanup-throw") {
      await expect(repair()).rejects.toMatchObject({ errors: [failure, cleanupFailure] });
    } else {
      await expect(repair()).rejects.toBe(failure);
    }
  } else {
    const result = await repair();
    if (succeeded) {
      expect(result).toMatchObject({
        repairedPluginIds: [first.pluginId],
        pluginInventoryChanged: true,
      });
      expect(result.records).toEqual({ ...records, [first.pluginId]: replacementRecord });
      if (multiple) {
        expect(result.failedPluginIds).toEqual(pluginIds.slice(1));
      }
      expectPublished(result.records, cfg, env);
    } else {
      expect(result.failedPluginIds).toEqual(pluginIds);
      expect(result.records).toEqual(records);
      expect(result.warnings).toContain(failure.message);
      if (scenario === "cleanup-error") {
        expect(result.warnings).toContainEqual(expect.stringContaining(cleanupFailure.message));
      }
      if (scenario === "consent-error") {
        expect(result.outcomes).toContainEqual(
          expect.objectContaining({
            pluginId: first.pluginId,
            status: "error",
            code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
          }),
        );
      }
      if (errorCode) {
        expect(result.notices ?? []).toEqual([]);
      }
    }
  }
  expect(first.isRetained()).toBe(
    preexisting ||
      succeeded ||
      ["cleanup-error", "cleanup-throw"].includes(scenario) ||
      authorityRefused,
  );
  if (markerAtRefusal !== undefined) {
    // Closed authority cannot remove persistent protection during compensation.
    expect(first.readMarker()).toBe(markerAtRefusal);
  }
  for (const [index, fixture] of fixtures.entries()) {
    expect(readPayload(fixture.rootDir)).toEqual(fixture.payload);
    if (markers[index] !== undefined) {
      expect(fixture.readMarker()).toBe(markers[index]);
    } else if (index > 0) {
      expect(fixture.isRetained()).toBe(false);
    }
  }
  expect(records).toEqual(originalRecords);
  if (scenario === "partial-marker-write" || authorityRefused || scenario === "effect-refused") {
    expect(updater).not.toHaveBeenCalled();
  }
  if (!succeeded && scenario !== "persist-throw") {
    expect(writeRecords).not.toHaveBeenCalled();
  }
  expect(npmInstaller).not.toHaveBeenCalled();
});

it.each(["unchanged", "missing-index", "changed-records", "changed-policy", "refused"] as const)(
  "awaits the final publication hook only for %s baseline effects",
  async (scenario) => {
    const root = tempDirs.make("openclaw-doctor-baseline-contract-");
    const env = { ...testEnv, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const cfg = { plugins: { enabled: false } } satisfies OpenClawConfig;
    const records = { retained: { source: "npm" as const, spec: "retained@1.0.0" } };
    const baselineRecords =
      scenario === "refused"
        ? {}
        : scenario === "changed-records"
          ? { ...records, extra: { source: "npm" as const, spec: "extra@1.0.0" } }
          : structuredClone(records);
    await useRealInstallIndexWrites();
    if (scenario !== "missing-index") {
      await seedInstalledPluginIndex(records, {
        env,
        config: scenario === "changed-policy" ? { plugins: { enabled: true } } : cfg,
        candidates: [],
      });
    }
    const before = await readPersistedInstalledPluginIndex({ env });
    let returned = false;
    const gate = Promise.withResolvers<void>();
    const entry = Promise.withResolvers<void>();
    const failure = new Error("baseline publication refused");
    const beforePersistentEffect = vi.fn(async () => {
      entry.resolve();
      await gate.promise;
      if (scenario === "refused") {
        throw failure;
      }
    });
    const pending = repairInstalls({
      cfg,
      env,
      pluginIds: [],
      baselineRecords,
      beforePersistentEffect,
    }).then((result) => {
      returned = true;
      return result;
    });
    if (scenario !== "unchanged") {
      await entry.promise;
      expect(returned).toBe(false);
      expect(await readPersistedInstalledPluginIndex({ env })).toEqual(before);
      expect(writeRecords).not.toHaveBeenCalled();
      gate.resolve();
    }
    if (scenario === "refused") {
      await expect(pending).rejects.toBe(failure);
      expect(writeRecords).not.toHaveBeenCalled();
      expect(await readPersistedInstalledPluginIndex({ env })).toEqual(before);
      return;
    }
    const result = await pending;
    expect(beforePersistentEffect).toHaveBeenCalledTimes(scenario === "unchanged" ? 0 : 1);
    expect(result.records).toEqual(baselineRecords);
    expect((await readPersistedInstalledPluginIndex({ env }))?.installRecords).toEqual(
      baselineRecords,
    );
  },
);
