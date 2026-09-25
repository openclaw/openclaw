import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { ManagedPluginLifecycleError } from "../plugins/management-lifecycle-error.js";
import {
  expectNoSideEffects,
  freshRestartCalls,
  getLogOutput,
  lastReplaceConfigCall,
  lastWriteJsonCall,
  mockMutableConfigSnapshot,
  npmPluginUpdateCall,
  syncPluginCall,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  loadInstalledPluginIndexInstallRecords,
  runtimeCapture,
  serviceLoaded,
  serviceRestart,
  serviceStop,
  spawn,
  syncPluginsForUpdateChannel,
} from "./update-cli-mocks.test-support.js";
import {
  createUpdateRun,
  defaultRuntime,
  expectPluginCapabilityRetryNotice,
  listUpdateRuns,
  makeOkUpdateResult,
  mockGitUpdateAfterMutation,
  mutateConfigFileWithRetry,
  readConfigFileSnapshot,
  replaceConfigFile,
  resolveGatewayInstallEntrypoint,
  resolveOpenClawPackageRoot,
  runDaemonRestart,
  runPostCorePluginConvergenceSpy,
  runUpdateFailureTriage,
  updateCommand,
  updateFinalizeCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import {
  mockPostCoreConvergenceOnce,
  pluginSyncResult,
  stableConfig,
} from "./update-cli/update-cli-config.test-support.js";
import {
  writeJsonFixture,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    baseConfig,
    baseSnapshot,
    configSnapshot,
    createCaseDir,
    FRESH_POST_UPDATE_ENTRYPOINT,
    mockFileBackedPathExists,
    mockGatewayHealth,
    mockNpmPluginOutcomes,
    mockOwnedGitService,
    runPostCoreCommand,
  } = createUpdateCliFixture();

  it("stages plugin-changing post-core config before updated plugin migrations run", async () => {
    syncPluginsForUpdateChannel.mockImplementationOnce(async ({ config }) =>
      pluginSyncResult(config, true),
    );

    await runPostCoreCommand({ restart: false });

    expect(lastReplaceConfigCall()).toMatchObject({
      writeOptions: { skipPluginValidation: true },
    });
  });

  it.each([false, true].flatMap((json) => [false, true].map((errored) => ({ json, errored }))))(
    "preserves convergence diagnostic output (json=$json, errored=$errored)",
    async ({ json, errored }) => {
      const repairWarning = {
        reason: "Package lookup deferred.",
        message: "Package lookup deferred.",
        guidance: ["Retry plugin repair."],
      };
      const smokeWarning = {
        pluginId: "reporting-fixture",
        reason: "missing-main-entry: entry missing",
        message: 'Plugin "reporting-fixture" failed payload verification.',
        guidance: ["Inspect the plugin entry."],
      };
      const notice = {
        reason: "Retained plugin remains available.",
        message: "Retained plugin remains available.",
        guidance: [],
      };
      const warnings = errored
        ? [repairWarning, { ...smokeWarning, kind: "load" as const }]
        : [repairWarning];
      const reportedRepairWarning = {
        ...repairWarning,
        message: "Plugin updates could not complete. Run `openclaw update repair` to retry.",
        guidance: ["openclaw update repair"],
      };
      const reportedSmokeWarning = {
        ...smokeWarning,
        message:
          'Plugin "reporting-fixture" could not be loaded. Run `openclaw doctor --fix` to check and repair the load problem.',
        guidance: ["openclaw doctor --fix"],
      };
      mockPostCoreConvergenceOnce(runPostCorePluginConvergenceSpy, {
        warnings,
        errored,
        notices: [notice],
      });
      const { updatePluginsAfterCoreUpdate } =
        await import("./update-cli/update-command-plugins.js");

      const result = await updatePluginsAfterCoreUpdate({
        root: process.cwd(),
        channel: "stable",
        configSnapshot: baseSnapshot,
        configWriteOptions: {},
        timeoutMs: 60_000,
        json,
      });

      expect(result).toEqual({
        status: "warning",
        assessment: errored
          ? { kind: "unsafe", reason: "convergence-failed" }
          : { kind: "no-payload-repair" },
        changed: false,
        warnings: [reportedRepairWarning, ...(errored ? [reportedSmokeWarning] : []), notice],
        sync: {
          changed: false,
          switchedToBundled: [],
          switchedToNpm: [],
          warnings: [],
          errors: [],
        },
        npm: {
          changed: false,
          outcomes: errored
            ? [{ pluginId: "reporting-fixture", status: "error", message: smokeWarning.message }]
            : [],
        },
        integrityDrifts: [],
      });
      const logs = vi
        .mocked(defaultRuntime.log)
        .mock.calls.map(([value]) => stripAnsi(String(value)));
      expect(logs).toEqual(
        json
          ? []
          : [
              "",
              "Updating plugins...",
              ...(errored ? ["Plugin updates: 0 updated, 0 unchanged, 1 to retry."] : []),
              reportedRepairWarning.message,
              ...(errored ? [reportedSmokeWarning.message] : []),
              notice.message,
            ],
      );
    },
  );

  it.each(
    [false, true].flatMap((json) =>
      [
        { label: "legacy version", fields: { version: "2026.9.2" } },
        { label: "resolved version", fields: { resolvedVersion: "2026.9.2" } },
        {
          label: "resolved version with stale alias",
          fields: { resolvedVersion: "2026.9.2", version: "2026.9.1" },
        },
      ].map(({ label, fields }) => ({ label, fields, json })),
    ),
  )("reports retained official pin advisories ($label, json=$json)", async ({ fields, json }) => {
    const installPath = createCaseDir("retained-pin");
    fsSync.mkdirSync(installPath, { recursive: true });
    fsSync.writeFileSync(
      path.join(installPath, "package.json"),
      JSON.stringify({
        name: "@openclaw/discord",
        version: "2026.9.2",
      }),
    );
    mockFileBackedPathExists();
    const message =
      "discord is pinned to @openclaw/discord@2026.9.2 (installed 2026.9.2); " +
      "registry latest resolves to 2026.9.3. Pass `openclaw plugins update " +
      "@openclaw/discord@latest` to replace this version pin.";
    const records: Record<string, PluginInstallRecord> = {
      discord: { source: "npm", spec: "@openclaw/discord@2026.9.2", installPath, ...fields },
    };
    mockNpmPluginOutcomes(
      [
        {
          pluginId: "discord",
          status: "unchanged",
          currentVersion: "2026.9.2",
          nextVersion: "2026.9.3",
          message,
        },
      ],
      false,
      { ...baseConfig, plugins: { ...baseConfig.plugins, installs: records } },
    );
    mockPostCoreConvergenceOnce(runPostCorePluginConvergenceSpy, {
      installRecords: records,
    });
    const { updatePluginsAfterCoreUpdate } = await import("./update-cli/update-command-plugins.js");
    const result = await updatePluginsAfterCoreUpdate({
      root: process.cwd(),
      channel: "stable",
      configSnapshot: baseSnapshot,
      configWriteOptions: {},
      timeoutMs: 60_000,
      json,
    });
    expect(result.status).toBe("warning");
    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        pluginId: "discord",
        reason: "retained-plugin-pin",
        message: expect.stringContaining(message),
      }),
    ]);
    expect(result.npm.outcomes[0]?.status).toBe("unchanged");
    expect(records.discord).toEqual({
      source: "npm",
      spec: "@openclaw/discord@2026.9.2",
      installPath,
      ...fields,
    });
    const output = stripAnsi(getLogOutput());
    expect(output.includes(message)).toBe(!json);
  });

  it.each([
    { name: "same version", nextVersion: "2026.9.2" },
    { name: "unknown registry version", nextVersion: undefined },
    { name: "invalid registry version", nextVersion: "unknown" },
    { name: "older registry version", nextVersion: "2026.9.1" },
    { name: "repaired record", version: "2026.9.3" },
    { name: "removed record", removed: true },
    { name: "third-party package", spec: "third-party-plugin@2026.9.2" },
    { name: "git source", source: "git" as const },
    { name: "ClawHub source", source: "clawhub" as const },
    { name: "version range", spec: "@openclaw/discord@^2026.9.2" },
    { name: "bare selector", spec: "@openclaw/discord" },
    { name: "default tag", spec: "@openclaw/discord@latest" },
    { name: "explicit non-default tag", spec: "@openclaw/discord@beta" },
    { name: "replaced exact pin", spec: "@openclaw/discord@2026.9.3" },
    { name: "repaired resolved record", resolvedVersion: "2026.9.3" },
    { name: "package replacement", beforeSpec: "third-party-plugin@2026.9.2" },
  ])("does not warn for $name during post-core convergence", async (entry) => {
    const installPath = createCaseDir("excluded-pin");
    fsSync.mkdirSync(installPath, { recursive: true });
    fsSync.writeFileSync(
      path.join(installPath, "package.json"),
      JSON.stringify({
        name: "@openclaw/discord",
        version: "2026.9.2",
      }),
    );
    mockFileBackedPathExists();
    const record: PluginInstallRecord = {
      source: entry.source ?? "npm",
      spec: entry.spec ?? "@openclaw/discord@2026.9.2",
      installPath,
      version: entry.version ?? "2026.9.2",
      ...("resolvedVersion" in entry ? { resolvedVersion: entry.resolvedVersion } : {}),
    };
    const beforeRecords: Record<string, PluginInstallRecord> = {
      discord: {
        ...record,
        spec: "beforeSpec" in entry ? entry.beforeSpec : record.spec,
        version: "2026.9.2",
        ...("resolvedVersion" in entry ? { resolvedVersion: "2026.9.2" } : {}),
      },
    };
    mockNpmPluginOutcomes(
      [
        {
          pluginId: "discord",
          status: "unchanged",
          currentVersion: "2026.9.2",
          nextVersion: "nextVersion" in entry ? entry.nextVersion : "2026.9.3",
          message: "Retained version.",
        },
      ],
      false,
      { ...baseConfig, plugins: { ...baseConfig.plugins, installs: beforeRecords } },
    );
    mockPostCoreConvergenceOnce(runPostCorePluginConvergenceSpy, {
      installRecords: entry.removed ? {} : { discord: record },
    });
    const { updatePluginsAfterCoreUpdate } = await import("./update-cli/update-command-plugins.js");
    const result = await updatePluginsAfterCoreUpdate({
      root: process.cwd(),
      channel: "stable",
      configSnapshot: baseSnapshot,
      configWriteOptions: {},
      timeoutMs: 60_000,
      json: true,
    });
    expect(result.status).toBe("ok");
    expect(result.warnings).toEqual([]);
  });

  it("preserves typed repair outcomes from post-core convergence", async () => {
    const consentOutcome = {
      pluginId: "consent-fixture",
      status: "error" as const,
      code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
      message: "Operator review token changed.",
    };
    mockPostCoreConvergenceOnce(runPostCorePluginConvergenceSpy, {
      errored: true,
      outcomes: [consentOutcome],
    });
    const { updatePluginsAfterCoreUpdate } = await import("./update-cli/update-command-plugins.js");

    const result = await updatePluginsAfterCoreUpdate({
      root: process.cwd(),
      channel: "stable",
      configSnapshot: baseSnapshot,
      configWriteOptions: {},
      timeoutMs: 60_000,
      json: true,
    });

    expect(result.status).toBe("warning");
    expect(result.npm.outcomes).toContainEqual(consentOutcome);
  });

  it("clears a retry notice when post-core repair succeeds", async () => {
    const failure = { pluginId: "demo", status: "error" as const, message: "Registry unavailable" };
    mockNpmPluginOutcomes([failure]);
    mockPostCoreConvergenceOnce(runPostCorePluginConvergenceSpy, {
      changes: ['Repaired plugin "demo".'],
      repairedPluginIds: ["demo"],
      installRecords: {
        demo: { source: "npm", spec: "@example/demo", installPath: "/p/demo", version: "1.0.1" },
      },
    });
    const { updatePluginsAfterCoreUpdate } = await import("./update-cli/update-command-plugins.js");

    const result = await updatePluginsAfterCoreUpdate({
      root: process.cwd(),
      channel: "stable",
      configSnapshot: baseSnapshot,
      configWriteOptions: {},
      timeoutMs: 60_000,
    });

    expect(result.status).toBe("ok");
    expect(result.warnings).toEqual([]);
    expect(result.npm.outcomes).toContainEqual(failure);
    expect(result.npm.outcomes.at(-1)).toMatchObject({
      pluginId: "demo",
      status: "updated",
      nextVersion: "1.0.1",
    });
    expect(getLogOutput()).not.toContain("to retry");
    expect(getLogOutput()).toContain("1 updated, 0 unchanged");
  });

  it.each([false, true])(
    "post-core resume children leave run ownership with the parent (forwarded run=%s)",
    async (forwardedRun) => {
      const resultDir = createCaseDir("openclaw-post-core-result");
      const resultPath = path.join(resultDir, "plugins.json");
      await fs.mkdir(resultDir, { recursive: true });
      const parentRun = forwardedRun
        ? createUpdateRun({
            trigger: "cli",
            before: { version: "2026.9.1" },
            target: { version: "2026.9.2" },
          })
        : undefined;
      const runsBefore = listUpdateRuns();

      await runPostCoreCommand(
        { restart: false },
        {
          OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: resultPath,
          OPENCLAW_UPDATE_RUN_ID: parentRun?.runId,
        },
      );

      const result = JSON.parse(await fs.readFile(resultPath, "utf-8")) as {
        status?: string;
      };
      expect(result.status).toBe("ok");
      expect(defaultRuntime.exit).toHaveBeenCalledWith(0);
      expectNoSideEffects(updateGitCheckout, spawn);
      expect(listUpdateRuns()).toEqual(runsBefore);
    },
  );

  it("post-core resume mode prefers post-doctor disk install records over the stale parent snapshot", async () => {
    const resultDir = createCaseDir("openclaw-post-core-disk-records");
    const recordsPath = path.join(resultDir, "plugin-install-records.json");
    await fs.mkdir(resultDir, { recursive: true });
    await writeJsonFixture(recordsPath, {
      stale: {
        source: "npm",
        spec: "@openclaw/stale@1.0.0",
        installPath: "/tmp/stale-plugin",
      },
    });
    const postDoctorRecords = {
      codex: {
        source: "npm",
        spec: "@openclaw/codex@2026.5.17",
        installPath: "/tmp/codex-plugin",
      },
    } satisfies Record<string, PluginInstallRecord>;
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(postDoctorRecords);

    await runPostCoreCommand(
      { json: true, restart: false },
      { OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH: recordsPath },
    );

    expect(syncPluginCall()?.config?.plugins?.installs).toEqual(postDoctorRecords);
  });

  it("post-core resume mode persists the requested update channel with the updated process", async () => {
    mockMutableConfigSnapshot(
      configSnapshot({ update: { channel: "stable" } }, { hash: "stable-hash" }),
    );

    await runPostCoreCommand(
      { restart: false },
      {
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "dev",
        OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: "dev",
      },
    );

    expect(updateGitCheckout).not.toHaveBeenCalled();
    expect(replaceConfigFile).toHaveBeenCalledWith({
      nextConfig: { update: { channel: "dev" } },
      baseHash: "stable-hash",
    });
    expect(mutateConfigFileWithRetry).toHaveBeenCalledExactlyOnceWith({
      mutate: expect.any(Function),
      writeOptions: {
        assertCurrent: expect.any(Function),
        beforeCommit: expect.any(Function),
        observe: false,
        skipPluginValidation: true,
      },
    });
    expect(syncPluginCall()?.channel).toBe("dev");
    expect(syncPluginCall()?.config?.update?.channel).toBe("dev");
  });

  it("post-core resume mode retries update channel persistence after config hash drift", async () => {
    vi.mocked(readConfigFileSnapshot).mockResolvedValueOnce(
      configSnapshot({ update: { channel: "stable" } }, { hash: "stable-hash" }),
    );
    const newerSnapshot = {
      ...configSnapshot({
        meta: { lastTouchedVersion: "2026.4.30" },
        update: { channel: "stable" },
      }),
      hash: "newer-hash",
    };
    vi.mocked(mutateConfigFileWithRetry).mockImplementationOnce(async (params) => {
      const nextConfig = structuredClone(newerSnapshot.sourceConfig);
      await params.mutate(nextConfig, {
        snapshot: newerSnapshot,
        previousHash: newerSnapshot.hash,
        attempt: 1,
      });
      vi.mocked(readConfigFileSnapshot).mockResolvedValue(
        configSnapshot(nextConfig, { hash: newerSnapshot.hash }),
      );
      return {
        path: newerSnapshot.path,
        previousHash: newerSnapshot.hash,
        snapshot: newerSnapshot,
        nextConfig,
        persistedHash: newerSnapshot.hash,
        result: undefined,
        attempts: 2,
        afterWrite: { mode: "none", reason: "test" },
        followUp: { mode: "none", reason: "test", requiresRestart: false },
      };
    });

    await runPostCoreCommand(
      { restart: false },
      {
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "dev",
        OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL: "dev",
      },
    );

    expect(mutateConfigFileWithRetry).toHaveBeenCalledTimes(1);
    expect(syncPluginCall()?.config?.meta?.lastTouchedVersion).toBe("2026.4.30");
    expect(syncPluginCall()?.config?.update?.channel).toBe("dev");
  });

  it("passes the update timeout budget into post-core plugin updates", async () => {
    await runPostCoreCommand({ restart: false, timeout: "1800" });

    expect(npmPluginUpdateCall()?.timeoutMs).toBe(1_800_000);
  });

  it("prints plugin channel fallbacks near the post-core plugin summary", async () => {
    mockNpmPluginOutcomes([
      {
        pluginId: "lossless-claw",
        status: "updated",
        message: "Updated lossless-claw: 1.0.0 -> 1.0.1.",
        channelFallback: {
          requestedSpec: "lossless-claw@beta",
          usedSpec: "lossless-claw",
          requestedLabel: "@beta",
          usedLabel: "@latest",
          reason: "unavailable",
          message:
            "plugin channel fallback: lossless-claw used @latest because @beta was unavailable",
        },
      },
    ]);

    await runPostCoreCommand({ restart: false }, { OPENCLAW_UPDATE_POST_CORE_CHANNEL: "beta" });

    const logs = vi.mocked(runtimeCapture.log).mock.calls.map((call) => String(call[0]));
    expect(logs.some((line) => line.includes("Plugin updates: 1 updated, 0 unchanged."))).toBe(
      true,
    );
    expect(
      logs.some((line) =>
        line.includes(
          "plugin channel fallback: lossless-claw used @latest because @beta was unavailable",
        ),
      ),
    ).toBe(true);
  });

  it.each([false, true])(
    "reports successful plugin source fallback without failing the core update (json=%s)",
    async (json) => {
      mockGitUpdateAfterMutation();
      const fallback = "@openclaw/demo unavailable; using clawhub:@openclaw/demo instead.";
      syncPluginsForUpdateChannel.mockImplementationOnce(
        async (params: {
          config: OpenClawConfig;
          logger?: { warn?: (message: string) => void };
        }) => {
          params.logger?.warn?.(fallback);
          const sync = pluginSyncResult(params.config, true, { warnings: [fallback] });
          return { ...sync, summary: { ...sync.summary, switchedToClawHub: ["demo"] } };
        },
      );

      await updateCommand({ yes: true, restart: false, json });

      const logs = vi
        .mocked(defaultRuntime.log)
        .mock.calls.map(([value]) => stripAnsi(String(value)));
      expect(logs.filter((line) => line === fallback)).toHaveLength(json ? 0 : 1);
      if (json) {
        expect(lastWriteJsonCall()).toMatchObject({
          status: "ok",
          postUpdate: { plugins: { sync: { warnings: [fallback] } } },
        });
      }
      expect(listUpdateRuns({ limit: 1 })[0]).toMatchObject({ status: "succeeded" });
    },
  );

  it("uses a fail-closed integrity policy for post-core plugin updates", async () => {
    await runPostCoreCommand({ restart: false });

    const updateCall = npmPluginUpdateCall() as
      | {
          onIntegrityDrift?: (drift: {
            pluginId: string;
            spec: string;
            expectedIntegrity: string;
            actualIntegrity: string;
            resolvedSpec?: string;
          }) => Promise<boolean>;
        }
      | undefined;
    const onIntegrityDrift = updateCall?.onIntegrityDrift;
    expect(onIntegrityDrift).toBeTypeOf("function");
    if (!onIntegrityDrift) {
      throw new Error("missing integrity drift handler");
    }

    vi.mocked(runtimeCapture.log).mockClear();
    await expect(
      onIntegrityDrift({
        pluginId: "demo",
        spec: "@openclaw/demo@1.0.0",
        resolvedSpec: "@openclaw/demo@1.0.0",
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-new",
      }),
    ).resolves.toBe(false);
    expect(getLogOutput()).not.toContain("sha512-old");
  });

  it.each(
    (["installed", "bridge"] as const).flatMap((source) =>
      (["update", "finalize"] as const).map((mode) => ({ source, mode })),
    ),
  )(
    "completes $mode with a plugin retry notice when $source awaits capability consent",
    async ({ source, mode }) => {
      const pluginId = "consent-fixture";
      const config = stableConfig({ plugins: { entries: { [pluginId]: { enabled: true } } } });
      vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config));
      mockOwnedGitService();
      mockGitUpdateAfterMutation(makeOkUpdateResult({ root: process.cwd() }));
      serviceLoaded.mockResolvedValue(true);
      if (source === "bridge") {
        const install = await import("../plugins/install.js");
        vi.spyOn(install, "installPluginFromNpmSpec").mockRejectedValueOnce(
          new ManagedPluginLifecycleError("Operator review token changed.", {
            capabilityConsent: { pluginId, reviewToken: "operator-review" },
          }),
        );
        const actual = await vi.importActual<typeof import("../plugins/update-channel.js")>(
          "../plugins/update-channel.js",
        );
        syncPluginsForUpdateChannel.mockImplementationOnce((params) =>
          actual.syncPluginsForUpdateChannel({
            ...params,
            externalizedBundledPluginBridges: [
              { bundledPluginId: pluginId, npmSpec: "@example/companion" },
            ],
          }),
        );
      } else {
        mockNpmPluginOutcomes([
          {
            pluginId,
            status: "error",
            code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
            message: "Operator review token changed.",
          },
        ]);
      }

      if (mode === "finalize") {
        const root = createCaseDir("consent-finalize");
        await writeOpenClawPackageFixture(root, "1.0.0", {
          git: true,
          builtSha: "a".repeat(40),
          entrySource: "export {};\n",
        });
        vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
        mockOwnedGitService(root);
        mockGatewayHealth("1.0.0", "consent-gateway", "fixture-original-build");
        vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
          FRESH_POST_UPDATE_ENTRYPOINT,
        );
      }
      const command =
        mode === "finalize"
          ? updateFinalizeCommand({ yes: true, json: true, restart: false })
          : updateCommand({ yes: true, json: true });
      await command;

      expectPluginCapabilityRetryNotice(lastWriteJsonCall(), { mode, source, pluginId });
      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      if (mode === "finalize") {
        expect(serviceStop).toHaveBeenCalledOnce();
        expect(serviceRestart).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ preserveDefinition: true }),
        );
        expectNoSideEffects(runDaemonRestart);
        expect(freshRestartCalls()).toHaveLength(0);
      }
      expect(runUpdateFailureTriage).not.toHaveBeenCalled();
    },
  );
});
