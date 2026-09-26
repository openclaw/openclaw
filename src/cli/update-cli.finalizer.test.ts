import path from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  completionCommandCall,
  expectNoSideEffects,
  getErrorOutput,
  lastNpmPluginUpdateCall,
  lastReplaceConfigCall,
  lastWriteJsonCall,
  replaceConfigCall,
  syncPluginCall,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  loadInstalledPluginIndexInstallRecords,
  pathExists,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  doctorCommand,
  ExitError,
  readConfigFileSnapshot,
  registerUpdateCli,
  replaceConfigFile,
  resolveGatewayInstallEntrypoint,
  resolveOpenClawPackageRoot,
  runCommandWithTimeout,
  runExec,
  updateFinalizeCommand,
} from "./update-cli-modules.test-support.js";
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
  const {
    baseConfig,
    baseSnapshot,
    configSnapshot,
    createCaseDir,
    expectFreshPostUpdateDoctor,
    FRESH_POST_UPDATE_ENTRYPOINT,
    mockFileBackedPathExists,
    setTty,
    tempDirs,
  } = createUpdateCliFixture();

  it("updateFinalizeCommand defers plugin installation during pre-plugin doctor", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(FRESH_POST_UPDATE_ENTRYPOINT);
    await withEnvAsync(
      {
        OPENCLAW_UPDATE_IN_PROGRESS: undefined,
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: undefined,
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
      async () => {
        let doctorEnv: NodeJS.ProcessEnv | undefined;
        vi.mocked(runExec).mockImplementationOnce(async (_file, _args, options) => {
          if (typeof options === "object") {
            doctorEnv = { ...options.baseEnv, ...options.env };
          }
          return { stdout: "", stderr: "" };
        });
        vi.mocked(defaultRuntime.writeJson).mockClear();

        await updateFinalizeCommand({
          json: true,
          yes: true,
          timeout: "9",
          restart: false,
        });

        expect(doctorEnv?.OPENCLAW_UPDATE_IN_PROGRESS).toBe("1");
        expect(doctorEnv?.OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR).toBe("1");
        expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE).toBe("1");
        expect(doctorEnv?.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE).toBeUndefined();
        expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
        expect(process.env.OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR).toBeUndefined();
        expect(process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE).toBeUndefined();
        expect(process.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE).toBe("1");
        expectFreshPostUpdateDoctor({ yes: true, workspaceSuggestions: true });
        expect(syncPluginCall()?.channel).toBe("stable");
        expect(lastNpmPluginUpdateCall()?.timeoutMs).toBe(9_000);
        expect(
          vi
            .mocked(readConfigFileSnapshot)
            .mock.calls.some(([options]) => options?.skipPluginValidation === true),
        ).toBe(true);
        const output = lastWriteJsonCall() as
          | {
              status?: string;
              mode?: string;
              restart?: boolean;
              phaseTimings?: Array<{
                phase?: string;
                startedOffsetMs?: number;
                durationMs?: number;
                outcome?: string;
              }>;
              postUpdate?: { doctor?: { status?: string }; plugins?: { status?: string } };
            }
          | undefined;
        expect(output?.status).toBe("ok");
        expect(output?.mode).toBe("finalize");
        expect(output?.restart).toBe(false);
        expect(output?.postUpdate?.doctor?.status).toBe("ok");
        expect(output?.postUpdate?.plugins?.status).toBe("ok");
        expect(output?.phaseTimings?.map((timing) => timing.phase)).toEqual([
          "preflight",
          "targetConfigValidation",
          "configSnapshot",
          "doctor",
          "plugins",
          "targetConfigConvergence",
          "completionCache",
        ]);
        for (const timing of output?.phaseTimings ?? []) {
          expect(timing.startedOffsetMs).toEqual(expect.any(Number));
          expect(timing.durationMs).toEqual(expect.any(Number));
        }
        expect(output?.phaseTimings?.map((timing) => timing.outcome)).toEqual([
          "completed",
          "completed",
          "completed",
          "completed",
          "completed",
          "completed",
          "skipped",
        ]);
      },
    );
  });

  it("updateFinalizeCommand can defer only the best-effort completion cache", async () => {
    pathExists.mockResolvedValue(true);
    vi.mocked(runCommandWithTimeout).mockClear();
    vi.mocked(defaultRuntime.writeJson).mockClear();

    await updateFinalizeCommand({
      json: true,
      yes: true,
      restart: false,
      deferCompletionCache: true,
    } as Parameters<typeof updateFinalizeCommand>[0] & { deferCompletionCache: boolean });

    expect(completionCommandCall()).toBeUndefined();
    const output = lastWriteJsonCall() as
      | { phaseTimings?: Array<{ phase?: string; outcome?: string }> }
      | undefined;
    expect(output?.phaseTimings?.at(-1)).toEqual(
      expect.objectContaining({ phase: "completionCache", outcome: "deferred" }),
    );
  });

  it("updateFinalizeCommand capability env applies only to the hidden finalizer", async () => {
    pathExists.mockResolvedValue(false);
    // Option wiring needs an idle installation; earlier workflow cases retain parent runs.
    await withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_STATE_DIR: tempDirs.make("openclaw-finalizer-options-"),
      },
      async () => {
        const run = async (command: "repair" | "finalize") => {
          vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(
            FRESH_POST_UPDATE_ENTRYPOINT,
          );
          vi.mocked(defaultRuntime.writeJson).mockClear();
          const program = new Command();
          program.name("openclaw");
          program.exitOverride();
          registerUpdateCli(program);
          await program.parseAsync(["node", "openclaw", "update", command, "--json", "--yes"]);
          const output = lastWriteJsonCall() as
            | { phaseTimings?: Array<{ phase?: string; outcome?: string }> }
            | undefined;
          return output?.phaseTimings?.at(-1);
        };

        expect(await run("repair"), getErrorOutput()).toEqual(
          expect.objectContaining({ phase: "completionCache", outcome: "skipped" }),
        );
        expect(await run("finalize")).toEqual(
          expect.objectContaining({ phase: "completionCache", outcome: "deferred" }),
        );
      },
    );
  });

  it.each(
    ["repair", "finalize"].flatMap((leaf) =>
      ["before", "after", "absent"].map((position) => ({ leaf, position })),
    ),
  )(
    "resolves capability consent $position $leaf without deriving it from --yes",
    async ({ leaf, position }) => {
      setTty(false);
      pathExists.mockResolvedValue(false);
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(FRESH_POST_UPDATE_ENTRYPOINT);
      const program = new Command();
      program.name("openclaw");
      program.exitOverride();
      registerUpdateCli(program);

      await withEnvAsync(
        { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-capability-options-") },
        () =>
          program.parseAsync([
            "node",
            "openclaw",
            "update",
            ...(position === "before" ? ["--accept-capabilities"] : []),
            leaf,
            ...(position === "after" ? ["--accept-capabilities"] : []),
            "--json",
            "--yes",
          ]),
      );

      const handler = syncPluginCall()?.onCapabilityConsent as
        | ((review: { reviewToken: string }) => Promise<{ reviewToken: string }>)
        | undefined;
      expect(syncPluginsForUpdateChannel, getErrorOutput()).toHaveBeenCalledOnce();
      expect(lastWriteJsonCall()).toMatchObject({ status: "ok", mode: "finalize" });
      if (position === "absent") {
        expect(handler).toBeUndefined();
      } else {
        await expect(handler?.({ reviewToken: "repair-reviewed-surface" })).resolves.toEqual({
          reviewToken: "repair-reviewed-surface",
        });
      }
    },
  );

  it("updateFinalizeCommand rejects extended-stable on Git before persistence", async () => {
    await expect(
      updateFinalizeCommand({
        channel: "extended-stable",
        json: true,
        restart: false,
      }),
    ).rejects.toEqual(new ExitError(1));

    expectNoSideEffects(replaceConfigFile, runExec, syncPluginsForUpdateChannel);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      mode: "git",
      reason: "unsupported_git_channel",
    });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("updateFinalizeCommand repairs doctor by default and refreshes plugin state after doctor", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint)
      .mockResolvedValueOnce(FRESH_POST_UPDATE_ENTRYPOINT)
      .mockResolvedValueOnce("/tmp/openclaw-entry.mjs");
    const preDoctorConfig = {
      update: { channel: "stable" },
      plugins: { entries: { pre: { enabled: true } } },
    } as OpenClawConfig;
    const postDoctorConfig = {
      update: { channel: "beta" },
      plugins: { entries: { post: { enabled: true } } },
    } as OpenClawConfig;
    const preDoctorSnapshot = configSnapshot(preDoctorConfig, {
      parsed: baseSnapshot.parsed,
      hash: "pre-doctor",
    });
    const postDoctorSnapshot = configSnapshot(postDoctorConfig, {
      parsed: baseSnapshot.parsed,
      hash: "post-doctor",
    });
    const postDoctorRecords = {
      "post-plugin": {
        source: "npm",
        spec: "post-plugin@1.0.0",
      },
    } satisfies Record<string, PluginInstallRecord>;
    let currentSnapshot = preDoctorSnapshot;
    vi.mocked(readConfigFileSnapshot).mockImplementation(async () => currentSnapshot);
    vi.mocked(runExec).mockImplementationOnce(async () => {
      currentSnapshot = postDoctorSnapshot;
      return { stdout: "", stderr: "" };
    });
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(postDoctorRecords);
    syncPluginsForUpdateChannel.mockImplementationOnce(
      async (params: { config?: OpenClawConfig }) =>
        pluginSyncResult(params.config ?? baseConfig, true),
    );
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
      npmPluginUpdateResult(config),
    );

    await updateFinalizeCommand({ json: true, timeout: "9", restart: false });

    expectFreshPostUpdateDoctor({ yes: false, workspaceSuggestions: true });
    const freshDoctorCall = vi
      .mocked(runExec)
      .mock.calls.find(
        ([, args]) => args[0] === "/tmp/openclaw-entry.mjs" && args.includes("doctor"),
      );
    expect(freshDoctorCall?.[1]).toEqual([
      "/tmp/openclaw-entry.mjs",
      "doctor",
      "--repair",
      "--non-interactive",
      "--no-workspace-suggestions",
    ]);
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
    expect(vi.mocked(runExec).mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      loadInstalledPluginIndexInstallRecords.mock.invocationCallOrder[0] ?? 0,
    );
    expect((lastWriteJsonCall() as { channel?: string } | undefined)?.channel).toBe("beta");
  });

  it("updateFinalizeCommand restores channels from the RPC pre-update config payload", async () => {
    const tempDir = createCaseDir("openclaw-rpc-finalize");
    const entryPath = await writeOpenClawPackageFixture(tempDir, "2026.6.18", {
      entrySource: "export {};\n",
    });
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(tempDir);
    mockFileBackedPathExists();
    const sourceConfigPath = path.join(tempDir, "source-config.json");
    const preUpdateConfig = {
      channels: {
        whatsapp: {
          enabled: true,
          dmPolicy: "pairing",
        },
      },
    } as OpenClawConfig;
    const postDoctorConfig = {
      meta: { lastTouchedVersion: "2026.6.18" },
    } as OpenClawConfig;
    const postDoctorSnapshot = configSnapshot(postDoctorConfig, {
      parsed: baseSnapshot.parsed,
      hash: "post-doctor",
    });
    await writeJsonFixture(sourceConfigPath, {
      sourceConfig: preUpdateConfig,
      authoredConfig: preUpdateConfig,
    });
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(postDoctorSnapshot);

    await withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: sourceConfigPath,
      },
      async () => {
        await updateFinalizeCommand({ json: true, restart: false });
      },
    );

    expect(syncPluginCall()?.config?.channels?.whatsapp).toEqual(
      preUpdateConfig.channels?.whatsapp,
    );
    expect(lastReplaceConfigCall()?.nextConfig?.channels?.whatsapp).toEqual(
      preUpdateConfig.channels?.whatsapp,
    );
    const finalizationCommands = vi
      .mocked(runExec)
      .mock.calls.filter(
        ([, args]) => args[0] === entryPath && ["doctor", "config"].includes(args[1] ?? ""),
      )
      .map(([, args]) => args.slice(1));
    expect(finalizationCommands).toEqual([
      ["doctor", "--repair", "--non-interactive"],
      ["doctor", "--repair", "--non-interactive", "--no-workspace-suggestions"],
      ["config", "validate", "--json"],
    ]);
    expect(doctorCommand).not.toHaveBeenCalled();
    expect(lastWriteJsonCall()).toMatchObject({ status: "ok" });
  });

  it("updateFinalizeCommand reapplies requested channel against post-doctor config", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(FRESH_POST_UPDATE_ENTRYPOINT);
    const preDoctorConfig = { update: { channel: "stable" } } as OpenClawConfig;
    const postDoctorConfig = { update: { channel: "beta" } } as OpenClawConfig;
    const preDoctorSnapshot = configSnapshot(preDoctorConfig, {
      parsed: baseSnapshot.parsed,
      hash: "pre-doctor",
    });
    const postDoctorSnapshot = configSnapshot(postDoctorConfig, {
      parsed: baseSnapshot.parsed,
      hash: "post-doctor",
    });
    let currentSnapshot = preDoctorSnapshot;
    vi.mocked(readConfigFileSnapshot).mockImplementation(async () => currentSnapshot);
    vi.mocked(runExec).mockImplementationOnce(async () => {
      currentSnapshot = postDoctorSnapshot;
      return { stdout: "", stderr: "" };
    });

    await updateFinalizeCommand({ channel: "dev", json: true, restart: false });

    expectFreshPostUpdateDoctor({ yes: false, workspaceSuggestions: true });
    expect(replaceConfigCall(0)?.baseHash).toBe("pre-doctor");
    expect(replaceConfigCall(0)?.nextConfig).toEqual({ update: { channel: "dev" } });
    expect(replaceConfigCall(1)?.baseHash).toBe("post-doctor");
    expect(replaceConfigCall(1)?.nextConfig).toEqual({ update: { channel: "dev" } });
    expect(syncPluginCall()?.channel).toBe("dev");
    expect((lastWriteJsonCall() as { channel?: string } | undefined)?.channel).toBe("dev");
  });

  it("updateFinalizeCommand converges on the effective channel from env without persisting update.channel", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(FRESH_POST_UPDATE_ENTRYPOINT);
    const noChannelConfig = {} as OpenClawConfig;
    const noChannelSnapshot = configSnapshot(noChannelConfig, {
      parsed: baseSnapshot.parsed,
      hash: "no-channel",
    });
    vi.mocked(readConfigFileSnapshot).mockResolvedValue(noChannelSnapshot);
    const priorEffective = process.env.OPENCLAW_UPDATE_EFFECTIVE_CHANNEL;
    // Simulate a no-config git/source update whose effective channel is dev.
    process.env.OPENCLAW_UPDATE_EFFECTIVE_CHANNEL = "dev";
    try {
      await updateFinalizeCommand({ json: true, restart: false });
    } finally {
      if (priorEffective === undefined) {
        delete process.env.OPENCLAW_UPDATE_EFFECTIVE_CHANNEL;
      } else {
        process.env.OPENCLAW_UPDATE_EFFECTIVE_CHANNEL = priorEffective;
      }
    }
    // Convergence runs on the effective (git/dev) channel...
    expect(syncPluginCall()?.channel).toBe("dev");
    // ...but the effective channel is never persisted to update.channel
    // (no requested channel), so a default source update does not mutate config.
    expect(syncPluginCall()?.config?.update?.channel).toBeUndefined();
    const persistedDevChannel = vi
      .mocked(replaceConfigFile)
      .mock.calls.some(([params]) => params?.nextConfig?.update?.channel === "dev");
    expect(persistedDevChannel).toBe(false);
  });
});
