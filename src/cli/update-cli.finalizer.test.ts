import path from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import {
  completionCommandCall,
  expectNoSideEffects,
  getErrorOutput,
  lastReplaceConfigCall,
  lastWriteJsonCall,
  requireValue,
  replaceConfigCall,
  syncPluginCall,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as update from "./update-cli-modules.test-support.js";
import {
  npmPluginUpdateResult,
  pluginSyncResult,
} from "./update-cli/update-cli-config.test-support.js";
import {
  writeJsonFixture,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const f = createUpdateCliFixture();
  const entrypoint = f.FRESH_POST_UPDATE_ENTRYPOINT;

  const repairArgs = ["doctor", "--repair", "--non-interactive"];
  const quietRepairArgs = [...repairArgs, "--no-workspace-suggestions"];
  const validationArgs = ["config", "validate", "--json"];
  const snapshot = (config: OpenClawConfig, hash: string) =>
    f.configSnapshot(config, { parsed: f.baseSnapshot.parsed, hash });
  const finalize = (options: Parameters<typeof update.updateFinalizeCommand>[0] = {}) =>
    update.updateFinalizeCommand({ json: true, ...options });
  const syncChanged = async ({ config }: { config?: OpenClawConfig }) =>
    pluginSyncResult(config ?? f.baseConfig, true);
  const mockFreshEntrypoint = () => {
    vi.mocked(update.resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
  };
  const runCli = async (args: string[]) => {
    const program = new Command();
    program.name("openclaw").exitOverride();
    update.registerUpdateCli(program);
    await program.parseAsync(["node", "openclaw", "update", ...args]);
  };

  it.each([
    { name: "Node", bun: undefined, failure: false },
    { name: "Bun failure diagnostics", bun: "1.4.3", failure: true },
  ])("uses the finalizer runtime for maintenance children under $name", async (runtime) => {
    const versions = requireValue(Object.getOwnPropertyDescriptor(process, "versions"), "versions");
    const nodeRunner = path.resolve("fixture-runtime", "node");
    const expectedRunner = runtime.bun ? process.execPath : nodeRunner;
    vi.spyOn(update.updateCliShared, "resolveNodeRunner").mockReturnValue(expectedRunner);
    Object.defineProperty(process, "versions", {
      value: { ...process.versions, bun: runtime.bun },
    });
    try {
      mockFreshEntrypoint();
      if (runtime.failure) {
        vi.mocked(update.runExec).mockRejectedValueOnce(new Error("Doctor could not complete"));
        await expect(finalize({ yes: true, timeout: "9" })).rejects.toThrow(
          "Doctor could not complete",
        );
        expect(update.runUpdateFailureTriage).toHaveBeenCalledOnce();
        expect(vi.mocked(update.runUpdateFailureTriage).mock.calls[0]?.[0].target).toMatchObject({
          nodeRunner: expectedRunner,
        });
        return;
      }
      mocks.pathExists.mockImplementation(async (candidate: string) =>
        candidate.endsWith("openclaw.mjs"),
      );
      mocks.syncPluginsForUpdateChannel.mockImplementation(syncChanged);
      const readiness = await import("./update-cli/update-command-post-plugin-readiness.js");
      const actualReadiness = await vi.importActual<typeof readiness>(
        "./update-cli/update-command-post-plugin-readiness.js",
      );
      vi.mocked(readiness.applyPostPluginUpdateReadiness).mockImplementation(
        actualReadiness.applyPostPluginUpdateReadiness,
      );
      const runOtherCommand = vi.mocked(update.runUtf8CommandWithTimeout).getMockImplementation();
      vi.mocked(update.runUtf8CommandWithTimeout).mockImplementation(async (argv, options) => {
        if (argv[2] === "doctor" && argv.includes("--lint")) {
          return createCommandResult({
            stdout: JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] }),
          });
        }
        if (!runOtherCommand) {
          throw new Error("Missing update command fixture");
        }
        return runOtherCommand(argv, options);
      });

      await finalize({ yes: true, timeout: "9" });

      const maintenance = vi
        .mocked(update.runExec)
        .mock.calls.filter(([, args]) => args[0] === entrypoint);
      expect(maintenance.map(([runner, args]) => [runner].concat(args.slice(1)))).toEqual([
        [expectedRunner, ...repairArgs, "--yes"],
        [expectedRunner, ...quietRepairArgs, "--yes"],
        [expectedRunner, ...validationArgs],
      ]);
      expect(
        vi.mocked(update.runUtf8CommandWithTimeout).mock.calls.map(([argv]) => argv),
      ).toContainEqual([
        expectedRunner,
        entrypoint,
        "doctor",
        "--lint",
        "--json",
        "--severity-min",
        "error",
      ]);
      expect(completionCommandCall()?.[0][0]).toBe(expectedRunner);
      expect(lastWriteJsonCall()).toMatchObject({ status: "ok", mode: "finalize" });
    } finally {
      Object.defineProperty(process, "versions", versions);
    }
  });

  it.each([
    { leaf: "repair", postCore: true, outcome: "skipped", consent: false },
    { leaf: "finalize", postCore: true, outcome: "deferred", consent: false },
    { leaf: "repair", postCore: false, consent: true },
    { leaf: "finalize", postCore: false, consent: false },
  ])(
    "resolves $leaf options: postCore=$postCore consent=$consent",
    async ({ leaf, postCore, outcome, consent }) => {
      if (!postCore) {
        f.setTty(false);
      }
      mocks.pathExists.mockResolvedValue(false);
      mockFreshEntrypoint();
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: f.tempDirs.make("openclaw-finalizer-options-"),
          ...(postCore ? { OPENCLAW_UPDATE_POST_CORE: "1" } : {}),
        },
        () => runCli([...(consent ? ["--accept-capabilities"] : []), leaf, "--json", "--yes"]),
      );
      if (postCore) {
        const output = lastWriteJsonCall() as
          | { phaseTimings?: Array<{ phase?: string; outcome?: string }> }
          | undefined;
        expect(output?.phaseTimings?.at(-1), getErrorOutput()).toMatchObject({
          phase: "completionCache",
          outcome,
        });
        return;
      }
      const handler = syncPluginCall()?.onCapabilityConsent as
        | ((review: { reviewToken: string }) => Promise<{ reviewToken: string }>)
        | undefined;
      expect(mocks.syncPluginsForUpdateChannel, getErrorOutput()).toHaveBeenCalledOnce();
      expect(lastWriteJsonCall()).toMatchObject({ status: "ok", mode: "finalize" });
      if (!consent) {
        expect(handler).toBeUndefined();
      } else {
        await expect(handler?.({ reviewToken: "repair-reviewed-surface" })).resolves.toEqual({
          reviewToken: "repair-reviewed-surface",
        });
      }
    },
  );

  it("updateFinalizeCommand rejects extended-stable on Git before persistence", async () => {
    await expect(finalize({ channel: "extended-stable" })).rejects.toEqual(new update.ExitError(1));

    expectNoSideEffects(
      update.replaceConfigFile,
      update.runExec,
      mocks.syncPluginsForUpdateChannel,
    );
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      mode: "git",
      reason: "unsupported_git_channel",
    });
    expect(update.defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([undefined, "dev"] as const)(
    "refreshes post-Doctor state with requested channel %s",
    async (requestedChannel) => {
      mockFreshEntrypoint();
      if (!requestedChannel) {
        vi.mocked(update.resolveGatewayInstallEntrypoint)
          .mockResolvedValueOnce(entrypoint)
          .mockResolvedValueOnce("/tmp/openclaw-entry.mjs");
      }
      const preDoctorConfig = {
        update: { channel: "stable" },
        ...(!requestedChannel ? { plugins: { entries: { pre: { enabled: true } } } } : {}),
      } satisfies OpenClawConfig;
      const postDoctorConfig = {
        update: { channel: "beta" },
        ...(!requestedChannel ? { plugins: { entries: { post: { enabled: true } } } } : {}),
      } satisfies OpenClawConfig;
      let currentSnapshot = snapshot(preDoctorConfig, "pre-doctor");
      const postDoctorSnapshot = snapshot(postDoctorConfig, "post-doctor");
      const postDoctorRecords = {
        "post-plugin": { source: "npm", spec: "post-plugin@1.0.0" },
      } satisfies Record<string, PluginInstallRecord>;
      vi.mocked(update.readConfigFileSnapshot).mockImplementation(async () => currentSnapshot);
      vi.mocked(update.runExec).mockImplementationOnce(async () => {
        currentSnapshot = postDoctorSnapshot;
        return { stdout: "", stderr: "" };
      });
      if (!requestedChannel) {
        mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(postDoctorRecords);
        mocks.syncPluginsForUpdateChannel.mockImplementationOnce(syncChanged);
        mocks.updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
          npmPluginUpdateResult(config),
        );
      }

      await finalize({
        channel: requestedChannel,
        ...(!requestedChannel ? { timeout: "9" } : {}),
      });

      f.expectFreshPostUpdateDoctor({ yes: false, workspaceSuggestions: true });
      if (requestedChannel) {
        for (const [index, baseHash] of ["pre-doctor", "post-doctor"].entries()) {
          const call = replaceConfigCall(index);
          expect(call?.baseHash).toBe(baseHash);
          expect(call?.nextConfig).toEqual({ update: { channel: "dev" } });
        }
        expect(syncPluginCall()?.channel).toBe("dev");
        expect((lastWriteJsonCall() as { channel?: string } | undefined)?.channel).toBe("dev");
        return;
      }
      const freshDoctorCall = vi
        .mocked(update.runExec)
        .mock.calls.find(
          ([, args]) => args[0] === "/tmp/openclaw-entry.mjs" && args.includes("doctor"),
        );
      expect(freshDoctorCall?.[1]).toEqual(["/tmp/openclaw-entry.mjs", ...quietRepairArgs]);
      expect(freshDoctorCall?.[2]).toMatchObject({
        cwd: process.cwd(),
        env: {
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
        },
      });
      expect(syncPluginCall()?.channel).toBe("beta");
      expect(syncPluginCall()?.config).toEqual({
        ...postDoctorConfig,
        plugins: {
          ...postDoctorConfig.plugins,
          installs: postDoctorRecords,
        },
      });
      expect(lastReplaceConfigCall()?.baseHash).toBe("post-doctor");
      expect(vi.mocked(update.runExec).mock.invocationCallOrder[0] ?? 0).toBeLessThan(
        mocks.loadInstalledPluginIndexInstallRecords.mock.invocationCallOrder[0] ?? 0,
      );
      expect((lastWriteJsonCall() as { channel?: string } | undefined)?.channel).toBe("beta");
    },
  );

  it("updateFinalizeCommand restores channels from the RPC pre-update config payload", async () => {
    const tempDir = f.createCaseDir("openclaw-rpc-finalize");
    const entryPath = await writeOpenClawPackageFixture(tempDir, "2026.6.18", {
      entrySource: "export {};\n",
    });
    vi.mocked(update.resolveOpenClawPackageRoot).mockResolvedValue(tempDir);
    f.mockFileBackedPathExists();
    const sourceConfigPath = path.join(tempDir, "source-config.json");
    const preUpdateConfig: OpenClawConfig = {
      channels: { whatsapp: { enabled: true, dmPolicy: "pairing" } },
    };
    await writeJsonFixture(sourceConfigPath, {
      sourceConfig: preUpdateConfig,
      authoredConfig: preUpdateConfig,
    });
    vi.mocked(update.readConfigFileSnapshot).mockResolvedValue(
      snapshot({ meta: { lastTouchedVersion: "2026.6.18" } }, "post-doctor"),
    );

    await withEnvAsync({ OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: sourceConfigPath }, () =>
      finalize(),
    );

    expect(syncPluginCall()?.config?.channels?.whatsapp).toEqual(
      preUpdateConfig.channels?.whatsapp,
    );
    expect(lastReplaceConfigCall()?.nextConfig?.channels?.whatsapp).toEqual(
      preUpdateConfig.channels?.whatsapp,
    );
    const finalizationCommands = vi
      .mocked(update.runExec)
      .mock.calls.filter(
        ([, args]) => args[0] === entryPath && ["doctor", "config"].includes(args[1] ?? ""),
      )
      .map(([, args]) => args.slice(1));
    expect(finalizationCommands).toEqual([repairArgs, quietRepairArgs, validationArgs]);
    expect(update.doctorCommand).not.toHaveBeenCalled();
    expect(lastWriteJsonCall()).toMatchObject({ status: "ok" });
  });

  it("updateFinalizeCommand converges on the effective channel from env without persisting update.channel", async () => {
    mockFreshEntrypoint();
    vi.mocked(update.readConfigFileSnapshot).mockResolvedValue(snapshot({}, "no-channel"));
    await withEnvAsync({ OPENCLAW_UPDATE_EFFECTIVE_CHANNEL: "dev" }, () => finalize());
    expect(syncPluginCall()?.channel).toBe("dev");
    expect(syncPluginCall()?.config?.update?.channel).toBeUndefined();
    const persistedDevChannel = vi
      .mocked(update.replaceConfigFile)
      .mock.calls.some(([params]) => params?.nextConfig?.update?.channel === "dev");
    expect(persistedDevChannel).toBe(false);
  });
});
