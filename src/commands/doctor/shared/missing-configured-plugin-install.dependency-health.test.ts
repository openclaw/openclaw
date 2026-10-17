// Register suite mocks before imports that read the install catalog.
import "./missing-configured-plugin-install.suite.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { resolveOpenClawPackageRootSync } from "../../../infra/openclaw-root.js";
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
const doctor = await import("./missing-configured-plugin-install.js");

function mockInstalledPlugins(records: unknown, plugins: unknown[]) {
  mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
  mocks.loadPluginMetadataSnapshot.mockReturnValue({ plugins, diagnostics: [] });
}

function expectNoPackageEffects() {
  expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
  expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
  expect(writeRecords).not.toHaveBeenCalled();
}

function readPayload(root: string, files: string[]) {
  return files.map((file) => fs.readFileSync(path.join(root, file), "utf8"));
}

function createRuntime(root: string) {
  fs.mkdirSync(root, { recursive: true });
  writePluginJson(root, "package.json", { name: "required-runtime", version: "1.0.0" });
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
    packageDependencies?: Record<string, string>;
    packageOptionalDependencies?: Record<string, string>;
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
  return {
    plugin,
    pluginId,
    rootDir,
    markerPath: resolveRetainedManagedNpmInstallMarkerPath(rootDir),
    manifest: fs.readFileSync(path.join(rootDir, "package.json"), "utf8"),
    record: {
      source: "npm" as const,
      spec: `${packageName}@${version}`,
      resolvedName: packageName,
      resolvedSpec: `${packageName}@${version}`,
      resolvedVersion: version,
      installPath: rootDir,
    },
  };
}

setupPluginInstallSuite();
it.each([
  "missing",
  "resolved-spec",
  "symlink-root",
  "ancestor",
  "hoisted",
  "deferred",
  "optional",
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
  const packageName = "dependency-plugin";
  const pluginId = "dependency-plugin";
  const { plugin } = createDependencyInstall(rootDir, pluginId, {
    packageName: scenario === "package-mismatch" ? "another-package" : packageName,
    packageOptionalDependencies: scenario === "optional" ? { "required-runtime": "2.0.0" } : {},
    origin: scenario === "bundled" ? "bundled" : "global",
  });
  const cfg: OpenClawConfig = { plugins: { entries: { [pluginId]: { enabled: true } } } };
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
    fs.mkdirSync(record.installPath);
    createColdPluginFixture({ rootDir: record.installPath, pluginId, packageName });
  } else if (scenario === "symlink-root") {
    record.installPath = path.join(parent, "linked-copy");
    fs.symlinkSync(rootDir, record.installPath, "junction");
  }
  if (scenario === "ancestor" || scenario === "hoisted") {
    const dependencyRoot = scenario === "hoisted" ? projectRoot : parent;
    const availableDir = path.join(dependencyRoot, "node_modules", "required-runtime");
    createRuntime(availableDir);
  }
  if (scenario === "unconfigured") {
    cfg.plugins = {};
  } else if (scenario === "disabled") {
    cfg.plugins = { entries: { [pluginId]: { enabled: false } } };
  } else if (scenario === "globally-disabled") {
    cfg.plugins = { ...cfg.plugins, enabled: false };
  } else if (scenario === "denylisted") {
    cfg.plugins = { ...cfg.plugins, deny: [pluginId] };
  } else if (scenario === "allowlist-excluded") {
    cfg.plugins = { ...cfg.plugins, allow: ["different-plugin"] };
  }
  if (scenario === "bundled") {
    mockCurrentBundledPlugin(pluginId, packageName);
  }
  mockInstalledPlugins({ [pluginId]: record }, [plugin]);
  const {
    configuredPluginInstallIssueToHealthFinding,
    configuredPluginInstallIssueToRepairEffect,
    detectConfiguredPluginInstallHealthIssues,
  } = doctor;

  const env =
    scenario === "deferred"
      ? {
          ...testEnv,
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
        }
      : testEnv;
  if (scenario === "unrequested") {
    const { repairMissingPluginInstallsForIds } = doctor;
    const beforePersistentEffect = vi.fn();
    const result = await repairMissingPluginInstallsForIds({
      cfg,
      env,
      pluginIds: [],
      beforePersistentEffect,
    });
    expect(result.changes).toEqual([]);
    expect(result.records).toEqual({ [pluginId]: record });
    expect(beforePersistentEffect).not.toHaveBeenCalled();
    expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(hasRetainedManagedNpmInstallMarker(rootDir)).toBe(false);
    return;
  }
  const issues = await detectConfiguredPluginInstallHealthIssues({ cfg, env });

  if (
    scenario === "missing" ||
    scenario === "resolved-spec" ||
    scenario === "symlink-root" ||
    scenario === "ancestor"
  ) {
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
    expect(configuredPluginInstallIssueToHealthFinding(issue)).toMatchObject({
      target: pluginId,
      source: "npm",
      message: expect.stringContaining("required-runtime"),
      fixHint:
        scenario === "resolved-spec"
          ? "Run `openclaw plugins install npm:dependency-plugin@1.2.3 --force` to reinstall the configured plugin package."
          : "Run `openclaw plugins install npm:dependency-plugin@1.0.0 --force` to reinstall the configured plugin package.",
    });
    expect(configuredPluginInstallIssueToRepairEffect(issue)).toMatchObject({
      kind: "package",
      action: "would-repair-configured-plugin-dependencies",
      dryRunSafe: false,
    });
  } else if (scenario === "deferred") {
    expect(issues).toEqual([
      {
        kind: "deferred-package-manager-repair",
        pluginId,
        installPath: record.installPath,
      },
    ]);
    const result = await repairConfiguredPlugins(cfg, env);
    expect(result.deferredRepairDetails).toEqual([expect.stringContaining(pluginId)]);
    expect(hasRetainedManagedNpmInstallMarker(rootDir)).toBe(false);
  } else {
    expect(issues).toEqual([]);
  }
  expectNoPackageEffects();
});

it.each(["managed", "flat"] as const)(
  "does not repair a healthy canonical host dependency in a %s install",
  async (layout) => {
    const parent = tempDirs.make("openclaw-doctor-host-dependency-");
    const pluginId = "host-dependency-plugin";
    const rootDir =
      layout === "managed"
        ? path.join(parent, "project", "node_modules", pluginId)
        : path.join(parent, pluginId);
    const hostRoot = expectDefined(
      resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url }),
      "running OpenClaw package root",
    );
    const dependencies = { "required-runtime": "1.0.0", openclaw: "*" };
    const { plugin, record } = createDependencyInstall(rootDir, pluginId, {
      packageDependencies: dependencies,
      packageOptionalDependencies: {},
    });
    const nodeModulesDir = path.join(rootDir, "node_modules");
    const runtimeDir = path.join(nodeModulesDir, "required-runtime");
    createRuntime(runtimeDir);
    fs.symlinkSync(hostRoot, path.join(nodeModulesDir, "openclaw"), "junction");
    const { auditOpenClawPeerDependencyLink } =
      await import("../../../plugins/plugin-peer-link.js");
    expect(await auditOpenClawPeerDependencyLink({ packageDir: rootDir })).toBeNull();
    const cfg: OpenClawConfig = { plugins: { entries: { [pluginId]: { enabled: true } } } };
    const records = { [pluginId]: record };
    mockInstalledPlugins(records, [plugin]);
    const { detectConfiguredPluginInstallHealthIssues } = doctor;

    for (let pass = 0; pass < 2; pass++) {
      expect(await detectConfiguredPluginInstallHealthIssues({ cfg, env: testEnv })).toEqual([]);
      const result = await repairConfiguredPlugins(cfg, testEnv);
      expect(result.changes).toEqual([]);
      expect(result.repairedPluginIds).toBeUndefined();
      expect(result.records).toEqual(records);
    }
    expect(fs.realpathSync(path.join(nodeModulesDir, "openclaw"))).toBe(fs.realpathSync(hostRoot));
    expectNoPackageEffects();
    expect(hasRetainedManagedNpmInstallMarker(rootDir)).toBe(false);
  },
);

// Batch settlement below covers updater/persistence throws and failed preexisting owners.
it.each([
  { outcome: "updated", preexisting: false, staleRuntime: false },
  { outcome: "unchanged", preexisting: false, staleRuntime: false },
  { outcome: "updated", preexisting: true, staleRuntime: true },
  { outcome: "skipped", preexisting: false, staleRuntime: false },
  { outcome: "consent-error", preexisting: false, staleRuntime: true },
  { outcome: "metadata-error", preexisting: false, staleRuntime: true },
  { outcome: "effect-refused", preexisting: false, staleRuntime: false },
  { outcome: "cleanup-error", preexisting: false, staleRuntime: false },
] as const)(
  "settles $outcome dependency repair (retained=$preexisting, stale=$staleRuntime)",
  async ({ outcome, preexisting, staleRuntime }) => {
    const parent = tempDirs.make("openclaw-doctor-dependency-repair-");
    const packageName = staleRuntime ? "@openclaw/codex" : "dependency-plugin";
    const pluginId = staleRuntime ? "codex" : "dependency-plugin";
    const version = staleRuntime ? "2026.9.1-beta.1" : "1.0.0";
    const env = { ...testEnv, OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.2" };
    const rootDir = path.join(parent, "node_modules", packageName);
    const fixture = createDependencyInstall(rootDir, pluginId, {
      packageName,
      packageVersion: version,
    });
    const payloadFiles = ["package.json", "openclaw.plugin.json", "index.cjs"];
    const originalPayload = readPayload(rootDir, payloadFiles);
    const markerPath = resolveRetainedManagedNpmInstallMarkerPath(rootDir);
    if (preexisting) {
      await markRetainedManagedNpmInstall({
        packageDir: rootDir,
        pluginId,
        retainedAt: "2026-05-01T00:00:00.000Z",
        reason: "existing-owner",
      });
    }
    const originalMarker = preexisting ? fs.readFileSync(markerPath, "utf8") : undefined;
    const record = {
      ...fixture.record,
      spec: staleRuntime ? packageName : `${packageName}@${version}`,
      integrity: "sha512-dependency-fixture",
      version,
    };
    const replacementRecord = { ...record, installPath: path.join(parent, "replacement") };
    const records = { [pluginId]: record };
    const originalRecords = structuredClone(records);
    const cfg: OpenClawConfig = {
      update: { channel: "beta" },
      plugins: { entries: { [pluginId]: { enabled: true } } },
    };
    mockInstalledPlugins(records, [fixture.plugin]);
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      officialPluginEntry({ id: pluginId, npmSpec: record.spec }),
    ]);
    const { resolveConfiguredPluginInstallContext } =
      await import("./missing-configured-plugin-install.candidates.js");
    const context = await resolveConfiguredPluginInstallContext({
      cfg,
      env,
      configuredPluginIds: new Set([pluginId]),
      configuredChannelIds: new Set(),
    });
    // The stale collision must satisfy both gates, without another force-repair reason.
    expect(context.installedPluginIdsWithStaleVersionBoundRuntimePackages).toEqual(
      new Set(staleRuntime ? [pluginId] : []),
    );
    expect(context.installedPluginMissingRequiredDependencies).toEqual(
      new Map([[pluginId, { rootDir, missingRequired: ["required-runtime"] }]]),
    );
    expect(context.installedPluginIdsWithRepairablePackageDiagnostics.size).toBe(0);
    expect(context.configuredPluginIdsWithStaleDescriptors.size).toBe(0);
    expect(context.officialReplacementPluginIds.has(pluginId)).toBe(false);
    expect(mocks.resolveNpmSpecMetadata).not.toHaveBeenCalled();
    const failure = new Error(`dependency repair ${outcome}`);
    const cleanupFailure = new Error("retention cleanup failed");
    if (outcome === "cleanup-error") {
      refuseMarkerCleanup(markerPath, cleanupFailure);
    }
    const beforePersistentEffect = vi.fn(async () => {
      if (beforePersistentEffect.mock.calls.length === 1) {
        expect(hasRetainedManagedNpmInstallMarker(rootDir)).toBe(preexisting);
      }
      if (outcome === "effect-refused") {
        throw failure;
      }
    });
    const onCapabilityConsent = vi.fn<PluginCapabilityConsentHandler>();
    mocks.updateNpmInstalledPlugins.mockImplementation(
      async (params: { config: OpenClawConfig }) => {
        expect(hasRetainedManagedNpmInstallMarker(rootDir)).toBe(true);
        const repairRecord = params.config.plugins?.installs?.[pluginId];
        expect(repairRecord).toStrictEqual({
          source: "npm",
          spec: record.spec,
          resolvedName: packageName,
          integrity: record.integrity,
          version,
          installPath: rootDir,
        });
        const status = ["consent-error", "metadata-error", "cleanup-error"].includes(outcome)
          ? "error"
          : outcome;
        if (status === "updated" || status === "unchanged") {
          createReplacement(replacementRecord.installPath, pluginId, packageName);
        }
        return {
          config: { plugins: { installs: { [pluginId]: replacementRecord } } },
          changed: status === "updated" || status === "unchanged",
          outcomes: [
            {
              pluginId,
              status,
              message: failure.message,
              ...(outcome === "consent-error"
                ? { code: PLUGIN_CAPABILITY_CONSENT_REQUIRED }
                : outcome === "metadata-error"
                  ? { code: PLUGIN_INSTALL_ERROR_CODE.NPM_METADATA_FAILURE }
                  : {}),
            },
          ],
        };
      },
    );
    const { repairMissingPluginInstallsForIds } = doctor;
    const repair = () =>
      repairMissingPluginInstallsForIds({
        cfg,
        pluginIds: [pluginId],
        env,
        beforePersistentEffect,
        onCapabilityConsent,
      });

    if (outcome === "effect-refused") {
      await expect(repair()).rejects.toBe(failure);
    } else {
      const result = await repair();
      if (outcome === "updated" || outcome === "unchanged") {
        expect(result).toMatchObject({
          repairedPluginIds: [pluginId],
          pluginInventoryChanged: true,
        });
        expect(result.records).toEqual({ [pluginId]: replacementRecord });
        expect(writeRecords).toHaveBeenCalledWith(
          result.records,
          expectedIndexWriteOptions(cfg, env),
        );
      } else {
        expect(result.failedPluginIds).toEqual([pluginId]);
        expect(result.records).toEqual(records);
        expect(result.warnings).toContain(failure.message);
        if (outcome === "cleanup-error") {
          expect(result.warnings).toContainEqual(expect.stringContaining(cleanupFailure.message));
        }
        expect(writeRecords).not.toHaveBeenCalled();
        if (outcome === "consent-error") {
          expect(result.outcomes).toContainEqual(
            expect.objectContaining({
              pluginId,
              status: "error",
              code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
            }),
          );
        }
        if (outcome === "consent-error" || outcome === "metadata-error") {
          expect(result.notices ?? []).toEqual([]);
        }
      }
    }
    expect(readPayload(rootDir, payloadFiles)).toEqual(originalPayload);
    expect(records).toEqual(originalRecords);
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    if (outcome === "effect-refused") {
      expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    } else {
      expect(mocks.updateNpmInstalledPlugins).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginIds: [pluginId],
          skipDisabledPlugins: true,
          beforePersistentEffect: expect.any(Function),
          onCapabilityConsent,
        }),
      );
    }
    const retained =
      preexisting ||
      outcome === "updated" ||
      outcome === "unchanged" ||
      outcome === "cleanup-error";
    expect(hasRetainedManagedNpmInstallMarker(rootDir)).toBe(retained);
    if (preexisting) {
      expect(fs.readFileSync(markerPath, "utf8")).toBe(originalMarker);
    }
  },
);

it.each([
  "mixed",
  "updater-throw",
  "persist-throw",
  "partial-marker-write",
  "second-effect-refused",
  "transaction-owner-refused",
  "cleanup-throw",
] as const)("settles multiple dependency repair owners after %s", async (scenario) => {
  const parent = tempDirs.make("openclaw-doctor-multiple-dependencies-");
  const pluginIds = ["dependency-a", "dependency-b", "dependency-c"];
  const fixtures = pluginIds.map((id) =>
    createDependencyInstall(path.join(parent, id, "node_modules", id), id),
  );
  const first = expectDefined(fixtures[0], "first dependency fixture");
  const second = expectDefined(fixtures[1], "second dependency fixture");
  const existing = expectDefined(fixtures[2], "preexisting dependency fixture");
  await markRetainedManagedNpmInstall({
    packageDir: existing.rootDir,
    pluginId: existing.pluginId,
    reason: "existing-owner",
  });
  const existingMarker = fs.readFileSync(existing.markerPath, "utf8");
  const records = Object.fromEntries(fixtures.map((item) => [item.pluginId, item.record]));
  const cfg: OpenClawConfig = {
    plugins: { entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])) },
  };
  mockInstalledPlugins(
    records,
    fixtures.map((fixture) => fixture.plugin),
  );
  const failure = new Error(`multiple dependency repair ${scenario}`);
  const cleanupFailure = new Error("first dependency marker cleanup failed");
  const authorityRefused = ["second-effect-refused", "transaction-owner-refused"].includes(
    scenario,
  );
  if (scenario === "partial-marker-write") {
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    vi.spyOn(fs.promises, "writeFile").mockImplementation(async (file, data, options) => {
      if (file === second.markerPath) {
        await writeFile(file, '{"partial":', options);
        throw failure;
      }
      return writeFile(file, data, options);
    });
  }
  if (scenario === "cleanup-throw") {
    refuseMarkerCleanup(first.markerPath, cleanupFailure);
  }
  let transactionOwned = true;
  let markerAtRefusal: string | undefined;
  const beforePersistentEffect = vi.fn(async () => {
    if (beforePersistentEffect.mock.calls.length === 2 && authorityRefused) {
      markerAtRefusal = fs.readFileSync(first.markerPath, "utf8");
      if (scenario === "second-effect-refused") {
        throw failure;
      }
      transactionOwned = false;
    }
  });
  const replacementRecord = { ...first.record, installPath: path.join(parent, "replacement") };
  mocks.updateNpmInstalledPlugins.mockImplementation(async () => {
    for (const fixture of fixtures) {
      expect(hasRetainedManagedNpmInstallMarker(fixture.rootDir)).toBe(true);
    }
    if (scenario === "updater-throw" || scenario === "cleanup-throw") {
      throw failure;
    }
    createReplacement(replacementRecord.installPath, first.pluginId);
    return {
      config: { plugins: { installs: { ...records, [first.pluginId]: replacementRecord } } },
      changed: true,
      outcomes: fixtures.map(({ pluginId }) => ({
        pluginId,
        status: pluginId === first.pluginId ? "updated" : "error",
        message: `repair outcome for ${pluginId}`,
      })),
    };
  });
  if (scenario === "persist-throw") {
    writeRecords.mockRejectedValueOnce(failure);
  }
  const { repairMissingPluginInstallsForIds } = doctor;
  const repair = () => {
    const params = { cfg, pluginIds, env: testEnv, beforePersistentEffect };
    return repairMissingPluginInstallsForIds(
      scenario === "transaction-owner-refused"
        ? requestDeferredPluginInstall(params, [], () => {
            if (!transactionOwned) {
              throw failure;
            }
          })
        : params,
    );
  };

  if (scenario === "mixed") {
    const result = await repair();
    expect(result.repairedPluginIds).toEqual([first.pluginId]);
    expect(result.failedPluginIds).toEqual([second.pluginId, existing.pluginId]);
    expect(result.records).toEqual({ ...records, [first.pluginId]: replacementRecord });
    expect(writeRecords).toHaveBeenCalledWith(
      result.records,
      expectedIndexWriteOptions(cfg, testEnv),
    );
  } else if (scenario === "cleanup-throw") {
    await expect(repair()).rejects.toMatchObject({ errors: [failure, cleanupFailure] });
  } else {
    await expect(repair()).rejects.toBe(failure);
  }
  expect(hasRetainedManagedNpmInstallMarker(first.rootDir)).toBe(
    scenario === "mixed" || scenario === "cleanup-throw" || authorityRefused,
  );
  if (markerAtRefusal !== undefined) {
    // Compensation cannot delete persistent protection after the initiating authority closes.
    expect(fs.readFileSync(first.markerPath, "utf8")).toBe(markerAtRefusal);
  }
  expect(hasRetainedManagedNpmInstallMarker(second.rootDir)).toBe(false);
  expect(fs.readFileSync(existing.markerPath, "utf8")).toBe(existingMarker);
  for (const fixture of fixtures) {
    expect(fs.readFileSync(path.join(fixture.rootDir, "package.json"), "utf8")).toBe(
      fixture.manifest,
    );
  }
  if (scenario === "partial-marker-write" || authorityRefused) {
    expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
  }
  if (scenario !== "mixed" && scenario !== "persist-throw") {
    expect(writeRecords).not.toHaveBeenCalled();
  }
  expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
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
    const { repairMissingPluginInstallsForIds } = doctor;
    const pending = repairMissingPluginInstallsForIds({
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
