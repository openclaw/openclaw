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
  runExec,
  runUpdateFailureTriage,
  runUtf8CommandWithTimeout,
  updateCliShared,
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

  const mockFreshDoctorProcess = (params: { failure?: string; onRepair?: () => void } = {}) => {
    const runOtherCommand = vi.mocked(runUtf8CommandWithTimeout).getMockImplementation();
    if (!runOtherCommand) {
      throw new Error("Missing update command fixture");
    }
    vi.mocked(runUtf8CommandWithTimeout).mockImplementation(async (argv, options) => {
      if (argv[2] === "doctor") {
        if (argv.includes("--lint")) {
          return {
            code: 0,
            signal: null,
            killed: false,
            termination: "exit",
            cleanup: "normal",
            stdout: JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] }),
            stderr: "",
          };
        }
        params.onRepair?.();
        return {
          code: params.failure ? 1 : 0,
          signal: null,
          killed: false,
          termination: "exit",
          cleanup: "normal",
          stdout: "",
          stderr: params.failure ?? "",
        };
      }
      const result = await runOtherCommand(argv, options);
      if (argv.at(-1) !== "--doctor") {
        return result;
      }
      params.onRepair?.();
      return params.failure ? { ...result, code: 1, stderr: params.failure } : result;
    });
  };

  const finalizationProcessCalls = (entrypoint: string) =>
    [
      ...vi
        .mocked(runUtf8CommandWithTimeout)
        .mock.calls.map(([argv], index) => ({
          runner: argv[0],
          commandArgs: argv.slice(2),
          order: vi.mocked(runUtf8CommandWithTimeout).mock.invocationCallOrder[index] ?? 0,
          entrypoint: argv[1],
        }))
        .filter(
          (call) =>
            call.entrypoint === entrypoint &&
            call.commandArgs[0] === "doctor" &&
            !call.commandArgs.includes("--lint"),
        ),
      ...vi
        .mocked(runExec)
        .mock.calls.map(([runner, args], index) => ({
          runner,
          commandArgs: args.slice(1),
          order: vi.mocked(runExec).mock.invocationCallOrder[index] ?? 0,
          entrypoint: args[0],
        }))
        .filter((call) => call.entrypoint === entrypoint && call.commandArgs[0] === "config"),
    ].toSorted((left, right) => left.order - right.order);

  it.each([
    { name: "Node", bun: undefined },
    { name: "Bun", bun: "1.4.3" },
  ])("uses the finalizer runtime for maintenance children under $name", async (runtime) => {
    const originalVersions = Object.getOwnPropertyDescriptor(process, "versions");
    if (!originalVersions) {
      throw new Error("Missing process.versions descriptor");
    }
    const nodeRunner = path.resolve("fixture-runtime", "node");
    const expectedRunner = runtime.bun ? process.execPath : nodeRunner;
    vi.spyOn(updateCliShared, "resolveNodeRunner").mockReturnValue(expectedRunner);
    Object.defineProperty(process, "versions", {
      value: { ...process.versions, bun: runtime.bun },
    });
    try {
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(FRESH_POST_UPDATE_ENTRYPOINT);
      pathExists.mockImplementation(async (candidate: string) =>
        candidate.endsWith("openclaw.mjs"),
      );
      syncPluginsForUpdateChannel.mockImplementation(async (params: { config?: OpenClawConfig }) =>
        pluginSyncResult(params.config ?? baseConfig, true),
      );
      const readiness = await import("./update-cli/update-command-post-plugin-readiness.js");
      const actualReadiness = await vi.importActual<typeof readiness>(
        "./update-cli/update-command-post-plugin-readiness.js",
      );
      vi.mocked(readiness.applyPostPluginUpdateReadiness).mockImplementation(
        actualReadiness.applyPostPluginUpdateReadiness,
      );
      mockFreshDoctorProcess();

      await updateFinalizeCommand({ json: true, yes: true, timeout: "9" });

      const maintenance = finalizationProcessCalls(FRESH_POST_UPDATE_ENTRYPOINT);
      expect(maintenance.map(({ runner, commandArgs }) => [runner, ...commandArgs])).toEqual([
        [expectedRunner, "doctor", "--repair", "--non-interactive", "--yes"],
        [
          expectedRunner,
          "doctor",
          "--repair",
          "--non-interactive",
          "--no-workspace-suggestions",
          "--yes",
        ],
        [expectedRunner, "config", "validate", "--json"],
      ]);
      expect(vi.mocked(runUtf8CommandWithTimeout).mock.calls.map(([argv]) => argv)).toContainEqual([
        expectedRunner,
        FRESH_POST_UPDATE_ENTRYPOINT,
        "doctor",
        "--lint",
        "--json",
        "--severity-min",
        "error",
      ]);
      expect(completionCommandCall()?.[0][0]).toBe(expectedRunner);
      expect(lastWriteJsonCall()).toMatchObject({ status: "ok", mode: "finalize" });
    } finally {
      Object.defineProperty(process, "versions", originalVersions);
    }
  });

  it("retains the invoking Bun runtime for failed finalization diagnostics", async () => {
    const originalVersions = Object.getOwnPropertyDescriptor(process, "versions");
    if (!originalVersions) {
      throw new Error("Missing process.versions descriptor");
    }
    const execPath = process.execPath;
    vi.spyOn(updateCliShared, "resolveNodeRunner").mockReturnValue(execPath);
    Object.defineProperty(process, "versions", {
      value: { ...process.versions, bun: "1.4.3" },
    });
    try {
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(FRESH_POST_UPDATE_ENTRYPOINT);
      mockFreshDoctorProcess({ failure: "Doctor could not complete" });

      await expect(updateFinalizeCommand({ json: true, yes: true, timeout: "9" })).rejects.toThrow(
        "Doctor could not complete",
      );

      expect(runUpdateFailureTriage).toHaveBeenCalledOnce();
      expect(vi.mocked(runUpdateFailureTriage).mock.calls[0]?.[0].target).toMatchObject({
        nodeRunner: execPath,
      });
    } finally {
      Object.defineProperty(process, "versions", originalVersions);
    }
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

  it.each([
    { leaf: "repair", position: "before" },
    { leaf: "finalize", position: "after" },
    { leaf: "finalize", position: "absent" },
  ])(
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
    mockFreshDoctorProcess({ onRepair: () => (currentSnapshot = postDoctorSnapshot) });
    loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(postDoctorRecords);
    syncPluginsForUpdateChannel.mockImplementationOnce(
      async (params: { config?: OpenClawConfig }) =>
        pluginSyncResult(params.config ?? baseConfig, true),
    );
    updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
      npmPluginUpdateResult(config),
    );

    await updateFinalizeCommand({ json: true, timeout: "9" });

    expectFreshPostUpdateDoctor({ yes: false, workspaceSuggestions: true });
    const freshDoctorCall = vi
      .mocked(runUtf8CommandWithTimeout)
      .mock.calls.find(([argv]) => argv[1] === "/tmp/openclaw-entry.mjs" && argv[2] === "doctor");
    expect(freshDoctorCall?.[0]).toEqual([
      expect.any(String),
      "/tmp/openclaw-entry.mjs",
      "doctor",
      "--repair",
      "--non-interactive",
      "--no-workspace-suggestions",
    ]);
    expect(freshDoctorCall?.[1]).toMatchObject({
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
    expect(vi.mocked(runUtf8CommandWithTimeout).mock.invocationCallOrder[0] ?? 0).toBeLessThan(
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
    mockFreshDoctorProcess();

    await withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: sourceConfigPath,
      },
      async () => {
        await updateFinalizeCommand({ json: true });
      },
    );

    expect(syncPluginCall()?.config?.channels?.whatsapp).toEqual(
      preUpdateConfig.channels?.whatsapp,
    );
    expect(lastReplaceConfigCall()?.nextConfig?.channels?.whatsapp).toEqual(
      preUpdateConfig.channels?.whatsapp,
    );
    const finalizationCommands = finalizationProcessCalls(entryPath).map(
      ({ commandArgs }) => commandArgs,
    );
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
    mockFreshDoctorProcess({ onRepair: () => (currentSnapshot = postDoctorSnapshot) });

    await updateFinalizeCommand({ channel: "dev", json: true });

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
      await updateFinalizeCommand({ json: true });
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
