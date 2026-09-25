import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "../plugins/clawhub-error-codes.js";
import {
  expectNoSideEffects,
  freshRestartCalls,
  getErrorOutput,
  getLogOutput,
  lastNpmPluginUpdateCall,
  lastWriteJsonCall,
  pluginOutcome,
  pluginWarning,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  loadInstalledPluginIndexInstallRecords,
  pathExists,
  spawn,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  mockGitUpdateAfterMutation,
  readConfigFileSnapshot,
  resolveGatewayInstallEntrypoint,
  runDaemonInstall,
  runDaemonRestart,
  runPostCorePluginConvergenceSpy,
  updateCommand,
} from "./update-cli-modules.test-support.js";
import {
  mockPostCoreConvergenceOnce,
  pluginSyncResult,
} from "./update-cli/update-cli-config.test-support.js";
import {
  mockUnbuiltRecoveryFixture,
  recoveryVerificationStep,
  recoveryVersionMismatch,
} from "./update-cli/update-cli-failure-recovery.test-support.js";
import { writeJsonFixture } from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    baseConfig,
    clawHubRiskWarning,
    clawHubSuspiciousPayloadWarning,
    clawHubSyncRiskError,
    configSnapshot,
    createCaseDir,
    mockNoopPostUpdatePluginConvergence,
    mockNpmPluginOutcomes,
    setupUpdatedRootRefresh,
  } = createUpdateCliFixture();

  it("keeps json update output successful when post-core plugin updates warn", async () => {
    updateNpmInstalledPlugins.mockImplementationOnce(
      async (params: {
        config: OpenClawConfig;
        onIntegrityDrift?: (drift: {
          pluginId: string;
          spec: string;
          resolvedSpec?: string;
          resolvedVersion?: string;
          expectedIntegrity: string;
          actualIntegrity: string;
          dryRun: boolean;
        }) => Promise<boolean>;
      }) => {
        const proceed = await params.onIntegrityDrift?.({
          pluginId: "demo",
          spec: "@openclaw/demo@1.0.0",
          resolvedSpec: "@openclaw/demo@1.0.0",
          resolvedVersion: "1.0.0",
          expectedIntegrity: "sha512-old",
          actualIntegrity: "sha512-new",
          dryRun: false,
        });
        return {
          changed: false,
          config: params.config,
          outcomes: [
            {
              pluginId: "demo",
              status: "error",
              message:
                proceed === false
                  ? "Failed to update demo: aborted: npm package integrity drift detected for @openclaw/demo@1.0.0"
                  : "unexpected drift continuation",
            },
          ],
        };
      },
    );
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(jsonOutput?.status).toBe("ok");
    expect(jsonOutput?.reason).toBeUndefined();
    expect(jsonOutput?.postUpdate?.plugins?.integrityDrifts).toEqual([
      {
        pluginId: "demo",
        spec: "@openclaw/demo@1.0.0",
        resolvedSpec: "@openclaw/demo@1.0.0",
        resolvedVersion: "1.0.0",
        expectedIntegrity: "sha512-old",
        actualIntegrity: "sha512-new",
        action: "aborted",
      },
    ]);
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginWarning(jsonOutput)?.guidance).toEqual(["openclaw plugins update demo"]);
    expect(pluginWarning(jsonOutput)?.reason).toContain("npm package integrity drift");
    expect(jsonOutput?.postUpdate?.plugins?.npm.outcomes[0]?.status).toBe("error");
    expect(jsonOutput?.postUpdate?.plugins?.npm.outcomes[0]?.message).toContain(
      "npm package integrity drift",
    );
  });

  it("includes non-blocking ClawHub trust warnings in json post-core plugin output", async () => {
    const trustWarning =
      "╭─ ClawHub Security Audit ─────────────────────────────────────────────╮\n" +
      "│ Outcome: Review                                                     │\n" +
      "│ Overview: The security scan is pending.                             │\n" +
      "╰────────────────────────────────────────────────────────────────────────╯";
    updateNpmInstalledPlugins.mockImplementationOnce(
      async (params: {
        config: OpenClawConfig;
        logger?: { terminalLinks?: boolean; warn?: (message: string) => void };
      }) => {
        expect(params.logger?.terminalLinks).toBe(false);
        params.logger?.warn?.(trustWarning);
        return {
          changed: false,
          config: params.config,
          outcomes: [
            {
              pluginId: "demo",
              status: "unchanged",
              message: "demo is up to date.",
            },
          ],
        };
      },
    );
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.reason).toBe(trustWarning);
    expect(pluginWarning(jsonOutput)?.guidance).toEqual([]);
    expect(pluginOutcome(jsonOutput)?.status).toBe("unchanged");
  });

  it("includes colored ClawHub trust warnings in json post-core plugin output", async () => {
    mockGitUpdateAfterMutation();
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    const trustWarning = clawHubRiskWarning;
    const coloredTrustWarning = `\u001b[33m${trustWarning}\u001b[39m`;
    updateNpmInstalledPlugins.mockImplementationOnce(
      async (params: {
        config: OpenClawConfig;
        logger?: { terminalLinks?: boolean; warn?: (message: string) => void };
      }) => {
        expect(params.logger?.terminalLinks).toBe(false);
        params.logger?.warn?.(coloredTrustWarning);
        return {
          changed: true,
          config: params.config,
          outcomes: [
            {
              pluginId: "demo",
              status: "updated",
              currentVersion: "1.2.3",
              nextVersion: "1.2.4",
              message: "Updated demo: 1.2.3 -> 1.2.4.",
            },
          ],
        };
      },
    );
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.reason).toBe(trustWarning);
    expect(pluginWarning(jsonOutput)?.reason).not.toContain("\u001b");
    expect(pluginOutcome(jsonOutput)?.status).toBe("updated");
  });

  it("includes failed ClawHub sync trust warnings in json post-core plugin output", async () => {
    const trustWarning = clawHubSuspiciousPayloadWarning;
    syncPluginsForUpdateChannel.mockResolvedValueOnce(
      pluginSyncResult(baseConfig, false, {
        warnings: [trustWarning],
        errors: [{ pluginId: "demo", message: clawHubSyncRiskError }],
      }),
    );
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(jsonOutput?.postUpdate?.plugins?.sync.warnings).toEqual([trustWarning]);
    expect(jsonOutput?.postUpdate?.plugins?.sync.errors).toEqual([clawHubSyncRiskError]);
  });

  it("does not print duplicate failed ClawHub sync trust warnings in human post-core output", async () => {
    const trustWarning = clawHubSuspiciousPayloadWarning;
    syncPluginsForUpdateChannel.mockImplementationOnce(
      async (params: { config: OpenClawConfig; logger?: { warn?: (message: string) => void } }) => {
        params.logger?.warn?.(trustWarning);
        return pluginSyncResult(params.config, false, {
          warnings: [trustWarning],
          errors: [{ pluginId: "demo", message: clawHubSyncRiskError }],
        });
      },
    );

    await updateCommand({ yes: true, restart: false });

    const logs = vi.mocked(defaultRuntime.log).mock.calls.map((call) => String(call[0]));
    expect(logs.filter((line) => line === trustWarning)).toHaveLength(1);
  });

  it("does not print duplicate ClawHub update trust warnings in human post-core output", async () => {
    const trustWarning = clawHubSuspiciousPayloadWarning;
    updateNpmInstalledPlugins.mockImplementationOnce(
      async (params: { config: OpenClawConfig; logger?: { warn?: (message: string) => void } }) => {
        params.logger?.warn?.(trustWarning);
        return {
          changed: false,
          config: params.config,
          outcomes: [
            {
              pluginId: "demo",
              status: "skipped",
              code: CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED,
              warning: trustWarning,
              message:
                "Skipped demo ClawHub update: ClawHub blocked this release; update was not started. Existing installed plugin left unchanged.",
            },
          ],
        };
      },
    );

    await updateCommand({ yes: true, restart: false });

    const output = getLogOutput();
    const trustWarningOccurrences = output.split(trustWarning).length - 1;
    expect(trustWarningOccurrences).toBe(1);
    expect(output).toContain("openclaw plugins update demo");
  });

  it("detects missing plugin payloads from persisted records before npm updates", async () => {
    mockNoopPostUpdatePluginConvergence();
    const installPath = createCaseDir("openclaw-missing-plugin-payload");
    fsSync.mkdirSync(installPath, { recursive: true });
    const config = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    } as OpenClawConfig;
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(configSnapshot(config));
    loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      demo: {
        source: "npm",
        spec: "@openclaw/demo@1.0.0",
        installPath,
      },
    });
    pathExists.mockImplementation(
      async (candidate: string) =>
        candidate === installPath || candidate === path.join(process.cwd(), "dist", "index.js"),
    );
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const updateCall = lastNpmPluginUpdateCall() as { skipIds?: Set<string> } | undefined;
    expect(updateCall?.skipIds?.has("demo")).toBe(true);
    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.status).toBe("ok");
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginWarning(jsonOutput)?.reason).toContain("package.json is missing");
    expect(pluginWarning(jsonOutput)).toMatchObject({
      message:
        'Plugin "demo" could not be loaded. Run `openclaw doctor --fix` to check and repair the load problem.',
      guidance: ["openclaw doctor --fix"],
    });
    expect(pluginOutcome(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginOutcome(jsonOutput)?.status).toBe("error");
  });

  it("prints non-fatal plugin warnings in human update output", async () => {
    mockNpmPluginOutcomes([
      {
        pluginId: "demo",
        status: "error",
        message: "Failed to update demo: registry timeout",
      },
    ]);

    await updateCommand({ yes: true, restart: false });

    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expectNoSideEffects(runDaemonInstall, runDaemonRestart);
    expect(freshRestartCalls()).toHaveLength(0);
    expect(getErrorOutput()).not.toContain("Update failed during plugin post-update sync.");
    const logs = getLogOutput();
    expect(logs).toContain('Plugin "demo" could not be updated.');
    expect(logs).toContain("openclaw plugins update demo");
  });

  it("marks disabled-after-failure plugin skips as post-update warnings", async () => {
    mockGitUpdateAfterMutation();
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    mockNpmPluginOutcomes(
      [
        {
          pluginId: "demo",
          status: "skipped",
          message:
            'Disabled "demo" after plugin update failure; OpenClaw will continue without it. Failed to update demo: registry timeout',
        },
      ],
      true,
    );
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginWarning(jsonOutput)?.guidance).toEqual(["openclaw plugins update demo"]);
    expect(pluginOutcome(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginOutcome(jsonOutput)?.status).toBe("skipped");
  });

  it.each([
    { json: false, repaired: false, version: "1.0.0" },
    { json: true, repaired: false, version: "1.0.0" },
    { json: true, repaired: true, version: "1.0.0" },
    { json: true, repaired: false, version: undefined },
  ])(
    "reports unavailable retained plugin targets without failing core ($json, repaired=$repaired, version=$version)",
    async ({ json, repaired, version }) => {
      const message =
        'Retained plugin "demo" at 1.0.0: requested @example/demo@2.0.0 for core 9999.0.0 could not be resolved: No matching version found. Run `openclaw plugins update demo` when the package or registry is available.';
      const installPath = createCaseDir("unavailable-target");
      await fs.mkdir(installPath, { recursive: true });
      await writeJsonFixture(path.join(installPath, "package.json"), {
        name: "@example/demo",
        version: "1.0.0",
      });
      const record: PluginInstallRecord = {
        source: "npm",
        spec: "@example/demo@2.0.0",
        installPath,
        version,
      };
      const records = { demo: record };
      const warningLogPath = path.join(installPath, "update-warning.log");
      setLoggerOverride({ level: "warn", file: warningLogPath });
      onTestFinished(async () => {
        await flushLogger();
        resetLogger();
      });
      loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mockNpmPluginOutcomes(
        [
          {
            pluginId: "demo",
            status: "unchanged",
            code: "plugin-target-unavailable",
            currentVersion: "1.0.0",
            message,
          },
        ],
        false,
        { ...baseConfig, plugins: { ...baseConfig.plugins, installs: records } },
      );
      mockPostCoreConvergenceOnce(runPostCorePluginConvergenceSpy, {
        installRecords: repaired ? { demo: { ...record, version: "2.0.0" } } : records,
      });

      await updateCommand({ yes: true, json, restart: false });

      expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      await flushLogger();
      const logEntries = fsSync.existsSync(warningLogPath)
        ? (await fs.readFile(warningLogPath, "utf8"))
            .trim()
            .split("\n")
            .map((line): unknown => JSON.parse(line))
        : [];
      const retainedWarning = expect.objectContaining({
        message,
        _meta: expect.objectContaining({ logLevelName: "WARN" }),
      });
      if (repaired) {
        expect(logEntries).not.toContainEqual(retainedWarning);
      } else {
        expect(logEntries).toContainEqual(retainedWarning);
      }
      if (json) {
        const result = lastWriteJsonCall();
        if (repaired) {
          expect(result).toMatchObject({ status: "ok", postUpdate: { plugins: { warnings: [] } } });
          return;
        }
        expect(result).toMatchObject({
          status: "ok",
          postUpdate: {
            plugins: {
              status: "warning",
              warnings: [
                expect.objectContaining({
                  pluginId: "demo",
                  reason: "plugin-target-unavailable",
                  message,
                }),
              ],
            },
          },
          run: {
            status: "succeeded",
            steps: expect.arrayContaining([
              expect.objectContaining({
                step: expect.stringMatching(/^warning:/),
                status: "completed",
                detail: expect.stringContaining(message),
              }),
            ]),
          },
        });
        expect(result).not.toHaveProperty("reason", "plugin-target-unavailable");
      } else {
        expect(stripAnsi(getLogOutput())).toContain(message);
      }
    },
  );

  it("marks blocked ClawHub update skips as post-update warnings", async () => {
    const trustWarning =
      "╭─ BLOCKED - ClawHub flagged this release as malicious ─╮\n" +
      "│ • Security scan: malicious                           │\n" +
      "╰──────────────────────────────────────────────────────╯";
    mockNpmPluginOutcomes([
      {
        pluginId: "demo",
        status: "skipped",
        code: "clawhub_download_blocked",
        warning: trustWarning,
        message:
          "Skipped demo ClawHub update: ClawHub blocked this release; update was not started. Existing installed plugin left unchanged.",
      },
    ]);
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(jsonOutput?.postUpdate?.plugins?.status).toBe("warning");
    expect(pluginWarning(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginWarning(jsonOutput)?.reason).toContain("Security scan: malicious");
    expect(pluginWarning(jsonOutput)?.reason).toContain("ClawHub blocked this release");
    expect(pluginOutcome(jsonOutput)?.pluginId).toBe("demo");
    expect(pluginOutcome(jsonOutput)?.status).toBe("skipped");
    expect(pluginOutcome(jsonOutput)?.message).toContain(
      "Existing installed plugin left unchanged",
    );
    expect(pluginWarning(jsonOutput)?.guidance).toEqual(["openclaw plugins update demo"]);
  });

  it.each([
    ["plugin sync", syncPluginsForUpdateChannel],
    ["npm update", updateNpmInstalledPlugins],
  ] as const)("fails unexpected post-core %s exceptions", async (phase, updatePlugins) => {
    await mockUnbuiltRecoveryFixture();
    const message = `${phase} invariant broke`;
    updatePlugins.mockRejectedValueOnce(new Error(message));

    await expect(updateCommand({ json: true, restart: false })).rejects.toEqual(new ExitError(1));
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "post-update-failed",
      steps: [
        expect.objectContaining({ exitCode: 1, stderrTail: message }),
        recoveryVerificationStep([recoveryVersionMismatch]),
      ],
    });
  });

  it("preserves fresh-process plugin warning details in parent json output", async () => {
    setupUpdatedRootRefresh();
    spawn.mockImplementationOnce((_node, _argv, options) => {
      const child = new EventEmitter() as EventEmitter & {
        once: EventEmitter["once"];
      };
      const env = (options as { env?: NodeJS.ProcessEnv }).env;
      queueMicrotask(() => {
        void (async () => {
          const resultPath = env?.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
          if (resultPath) {
            await fs.writeFile(
              resultPath,
              JSON.stringify({
                status: "warning",
                changed: false,
                warnings: [
                  {
                    pluginId: "demo",
                    reason: "Failed to update demo: registry timeout",
                    message:
                      'Plugin "demo" could not be processed after the core update: Failed to update demo: registry timeout Run openclaw update repair to retry post-update plugin repair. Run openclaw plugins inspect demo --runtime --json for details.',
                    guidance: [
                      "Run openclaw update repair to retry post-update plugin repair.",
                      "Run openclaw plugins inspect demo --runtime --json for details.",
                    ],
                  },
                ],
                sync: {
                  changed: false,
                  switchedToBundled: [],
                  switchedToNpm: [],
                  warnings: [],
                  errors: [],
                },
                npm: {
                  changed: false,
                  outcomes: [
                    {
                      pluginId: "demo",
                      status: "error",
                      message: "Failed to update demo: registry timeout",
                    },
                  ],
                },
                integrityDrifts: [],
              }),
              "utf-8",
            );
          }
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        })();
      });
      return child;
    });
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateCommand({ yes: true, json: true, restart: false });

    const jsonOutput = lastWriteJsonCall() as UpdateRunResult | undefined;
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(jsonOutput?.status).toBe("ok");
    expect(jsonOutput?.reason).toBeUndefined();
    expect(jsonOutput?.postUpdate?.plugins?.warnings?.[0]?.guidance).toContain(
      "Run openclaw update repair to retry post-update plugin repair.",
    );
    expect(jsonOutput?.postUpdate?.plugins?.npm.outcomes[0]?.message).toContain("registry timeout");
  });
});
