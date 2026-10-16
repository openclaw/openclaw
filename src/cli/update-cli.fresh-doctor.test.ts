import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { recordCommandProcessFailure } from "../process/exec-result.js";
import { VERSION } from "../version.js";
import { quoteCliArg } from "./quote-cli-arg.js";
import {
  commandCalls,
  expectNoSideEffects,
  getErrorOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
  spawnCall,
  getLogOutput,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  readPackageVersion,
  spawn,
  updateNpmInstalledPlugins,
  gatewayFixturePid,
  nodeVersionSatisfiesEngine,
  resolveNodeRuntimeInfo,
  serviceDefinitionMutationCapability,
  serviceLoaded,
  serviceReadCommand,
  serviceReadRuntime,
  serviceStop,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  doctorChild,
  ExitError,
  expectDelegatedPluginDoctorInput,
  makeOkUpdateResult,
  readConfigFileSnapshot,
  replaceConfigFile,
  resolveGatewayInstallEntrypoint,
  resolveOpenClawPackageRoot,
  resolveUpdateInstallKind,
  runExec,
  runPostCorePluginConvergenceSpy,
  runUtf8CommandWithTimeout,
  updateCommand,
  updateGitCheckout,
  fetchNpmPackageTargetStatus,
  runCommandWithTimeout,
} from "./update-cli-modules.test-support.js";
import { registerForegroundFailureRecoveryTests } from "./update-cli/update-cli-failure-recovery.test-support.js";
import {
  writeGitUpdateResultFixture,
  packageTargetStatus,
} from "./update-cli/update-cli-package.test-support.js";
import * as runtimeRecovery from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const {
    baseConfig,
    baseSnapshot,
    completeChangedPostCorePluginUpdate,
    createCaseDir,
    FRESH_POST_UPDATE_ENTRYPOINT,
    mockCurrentProcessFreshDoctor,
    mockNpmPluginOutcomes,
    primeNpmChannelTag,
    setupUpdatedRootRefresh,
  } = createUpdateCliFixture();

  it("carries explicit capability consent into post-core plugin convergence", async () => {
    const { entrypoints } = setupUpdatedRootRefresh({
      gatewayUpdateImpl: (root) =>
        writeGitUpdateResultFixture({
          root,
          before: { sha: "old-sha", version: "2026.4.26" },
          after: { sha: "new-sha", version: VERSION },
        }),
    });
    const runOtherCommand = requireValue(
      vi.mocked(runExec).getMockImplementation(),
      "update command fixture",
    );
    vi.mocked(runExec).mockImplementation(async (command, args, options) => {
      if (
        args.length === 3 &&
        args[0] === entrypoints[0] &&
        args[1] === "update" &&
        args[2] === "--help"
      ) {
        return {
          stdout: new Command("update").option("--accept-capabilities").helpInformation(),
          stderr: "",
        };
      }
      return runOtherCommand(command, args, options);
    });

    await updateCommand({ acceptCapabilities: true, yes: true, restart: false });

    expect(spawnCall()?.[1]).toEqual([
      entrypoints[0],
      "update",
      "--no-restart",
      "--yes",
      "--accept-capabilities",
      "--timeout",
      "1800",
    ]);
  });

  it.each([true])(
    "checks original Git version before a package downgrade (dry-run=%s)",
    async (dryRun) => {
      vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(
        createCaseDir("openclaw-git-downgrade"),
      );
      readPackageVersion.mockResolvedValue("2026.9.3-beta.1");
      primeNpmChannelTag("latest", "2026.9.1");

      const command = updateCommand({ channel: "stable", json: true, dryRun });

      await command;
      expect(lastWriteJsonCall()).toMatchObject({
        currentVersion: "2026.9.3-beta.1",
        targetVersion: "2026.9.1",
        downgradeRisk: true,
        switchToPackage: true,
      });

      expect(packageInstallCommandCall()?.[0]).toBeUndefined();
      expectNoSideEffects(updateGitCheckout, replaceConfigFile, spawn);
    },
  );

  it("pins the compatibility host version to the downgraded target during current-process post-core plugin convergence (#87914)", async () => {
    const downgradedRoot = createCaseDir("openclaw-downgraded-compat-root");
    vi.mocked(resolveUpdateInstallKind).mockImplementation(async (root) =>
      root === downgradedRoot ? "package" : "git",
    );
    setupUpdatedRootRefresh({
      targetVersion: "2026.4.10",
      gatewayUpdateImpl: async () =>
        makeOkUpdateResult({
          mode: "npm",
          root: downgradedRoot,
          before: { version: "2026.4.14" },
          after: { version: "2026.4.10" },
        }),
    });
    // The old core is still installed at the invocation root; the freshly
    // installed downgraded target lives at the post-update root.
    readPackageVersion.mockImplementation(async (pkgRoot: string) =>
      pkgRoot === downgradedRoot ? "2026.4.10" : "2026.4.14",
    );
    primeNpmChannelTag("latest", "2026.4.10");

    delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    mockCurrentProcessFreshDoctor({ postCoreResumeAttempt: false });
    let hostVersionDuringPluginUpdate: string | undefined = "unset";
    updateNpmInstalledPlugins.mockImplementation(async () => {
      hostVersionDuringPluginUpdate = process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
      return { changed: false, config: baseConfig, outcomes: [] };
    });

    try {
      await updateCommand({ yes: true, tag: "2026.4.10", restart: false });

      expect(spawn).not.toHaveBeenCalled();
      expect(updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
      // Compatibility is evaluated against the downgraded target core, not the
      // still-running old VERSION, so incompatible newer plugins are disabled
      // before restart.
      expect(hostVersionDuringPluginUpdate).toBe("2026.4.10");
      expect(runPostCorePluginConvergenceSpy).toHaveBeenCalledWith(
        expect.objectContaining({ compatibilityHostVersion: "2026.4.10" }),
      );
      // The override is scoped to the plugin convergence and restored afterward.
      expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
    } finally {
      delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    }
  });

  it("runs updated plugin migrations for a plugin-only current-process update", async () => {
    // This path exercises delegated Doctor ownership, independent of repository build artifacts.
    vi.spyOn(doctorChild, "inspectUpdateDoctorChildSupport").mockResolvedValue(true);
    readPackageVersion.mockResolvedValue(VERSION);
    vi.mocked(updateGitCheckout).mockResolvedValue(
      runtimeRecovery.currentGitCoreFixture(process.cwd(), VERSION).outcome,
    );
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    mockNpmPluginOutcomes([], true);
    let strictValidationEnv: string | undefined;
    vi.mocked(readConfigFileSnapshot).mockImplementation(async (options) => {
      if (!options?.skipPluginValidation) {
        strictValidationEnv = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
      }
      return baseSnapshot;
    });

    await updateCommand({ yes: true, restart: false });

    expect(spawn).not.toHaveBeenCalled();
    expect(resolveGatewayInstallEntrypoint).toHaveBeenCalledTimes(1);
    const doctorCalls = commandCalls().filter(([argv]) => argv.at(-1) === "--doctor");
    expect(doctorCalls).toHaveLength(1);
    expectDelegatedPluginDoctorInput(doctorCalls[0]?.[1].input);
    const freshCommands = vi
      .mocked(runExec)
      .mock.calls.filter(([, args]) => args[0] === FRESH_POST_UPDATE_ENTRYPOINT)
      .map(([command, args, options]) => ({
        command,
        args,
        env: typeof options === "object" ? options.env : undefined,
      }));
    expect(freshCommands).toEqual([
      {
        command: expect.any(String),
        args: [FRESH_POST_UPDATE_ENTRYPOINT, "config", "validate", "--json"],
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" },
      },
    ]);
    expect(strictValidationEnv).toBe("0");
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("records diagnostics as a warning when the fresh plugin doctor cannot run", async () => {
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      "/tmp/openclaw-updated-entry.mjs",
    );
    vi.mocked(runUtf8CommandWithTimeout).mockRejectedValueOnce(
      recordCommandProcessFailure(
        Object.assign(new Error("Command failed: " + "long-argv-prefix ".repeat(100)), {
          stderr: "doctor process failed: optional plugin repair unavailable",
          stdout: "doctor diagnostic output",
        }),
        { code: 1, cleanup: "normal", termination: "exit" },
      ),
    );
    const result = await completeChangedPostCorePluginUpdate();

    expect(result.pluginUpdate).toMatchObject({
      status: "warning",
      reason: "post-plugin-doctor-execution-failed",
    });
    expect(result.pluginUpdate.warnings?.at(-1)?.message).toContain("doctor process failed");
    expect(result.pluginUpdate.warnings?.at(-1)?.message).toContain("doctor diagnostic output");
    expect(result.pluginUpdate.warnings?.at(-1)?.message).not.toContain("long-argv-prefix");
  });

  registerForegroundFailureRecoveryTests({
    setupUpdatedRootRefresh,
    spawn,
    updateCommand,
    defaultRuntime,
    ExitError,
    spawnCall,
    lastWriteJsonCall,
    updateNpmInstalledPlugins,
  });
});

describe("update-cli", () => {
  const {
    mockFileBackedPathExists,
    mockPackageInstallStatus,
    mockServicePackageCommands,
    primeNpmChannelTag,
    primeServiceCommand,
    setupServicePackageAtPrefix,
    tempDirs,
  } = createUpdateCliFixture();

  beforeEach(() => runtimeRecovery.stubNodeRuntime());

  it("preserves split-root package updates when the service definition is writable-overridden", async () => {
    const oldInstall = await setupServicePackageAtPrefix({
      prefix: tempDirs.make("sealed-node-a-"),
    });
    const shellInstall = await setupServicePackageAtPrefix({
      prefix: tempDirs.make("sealed-node-b-"),
    });
    mockPackageInstallStatus(shellInstall.root);
    readPackageVersion.mockImplementation(
      async (root: string) =>
        JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version,
    );
    const originalCommand = [oldInstall.serviceNode, oldInstall.entrypoint, "gateway"];
    primeServiceCommand(originalCommand);
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: gatewayFixturePid,
      state: "running",
    });
    serviceDefinitionMutationCapability.mockResolvedValue({
      kind: "writable",
      reason: "inspection-failed",
    });
    const overriddenCommand = {
      programArguments: originalCommand,
      environment: { NODE_OPTIONS: "--max-old-space-size=4096" },
      managedDefinition: { programArguments: originalCommand },
      managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } },
    };
    serviceReadCommand.mockResolvedValue(overriddenCommand);
    primeNpmChannelTag("latest", "2026.5.20");
    mockFileBackedPathExists();
    const transports = [oldInstall, shellInstall].map((install) => {
      mockServicePackageCommands({
        nodeModules: install.nodeModules,
        packageRoot: install.root,
        targetVersion: "2026.5.20",
        npmCommands: ["npm", install.serviceNpm, requireValue(install.serviceNpmReal, "npm")],
        nodeVersions: { [oldInstall.serviceNode]: "v24.19.0" },
      });
      return requireValue(
        vi.mocked(runCommandWithTimeout).getMockImplementation(),
        "package transport",
      );
    });
    const oldPrefix = path.dirname(path.dirname(oldInstall.serviceNode));
    vi.mocked(runCommandWithTimeout).mockImplementation((argv, options) => {
      const context =
        typeof options === "object" && options !== null
          ? [options.cwd ?? "", options.env?.PATH ?? ""]
          : [];
      const old = [...argv, ...context].some((value) => value.includes(oldPrefix));
      return transports[old ? 0 : 1]!(argv, options);
    });
    await updateCommand({ yes: true }).catch((cause: unknown) => {
      throw new Error(getErrorOutput() + getLogOutput(), { cause });
    });
    expect(
      JSON.parse(await fs.readFile(path.join(oldInstall.root, "package.json"), "utf8")).version,
    ).toBe("2026.5.20");
    expect(
      JSON.parse(await fs.readFile(path.join(shellInstall.root, "package.json"), "utf8")).version,
    ).toBe("2026.5.18");
    expect((await serviceReadCommand(process.env)).programArguments).toEqual(originalCommand);
    expect(await serviceReadCommand(process.env)).toEqual(overriddenCommand);
    const installCalls = commandCalls().filter(
      ([argv]) => argv[2] === "gateway" && argv[3] === "install",
    );
    expect(installCalls).toHaveLength(1);
    expect(installCalls[0]?.[0].slice(0, 4)).toEqual([
      oldInstall.serviceNode,
      oldInstall.entrypoint,
      "gateway",
      "install",
    ]);
    expect(installCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        cwd: oldInstall.root,
        input: expect.stringContaining('"targetRoot":' + JSON.stringify(oldInstall.root)),
      }),
    );
    expect(serviceStop).toHaveBeenCalledOnce();
    expect(getLogOutput()).toContain("Gateway: restarted and verified");
  });

  it.each([{ capability: "sealed" }, { capability: "writable" }] as const)(
    "preserves target compatibility for an unchanged service launcher ($capability)",
    async ({ capability }) => {
      const fixture = await setupServicePackageAtPrefix({
        prefix: tempDirs.make("preserved-runtime-"),
      });
      const serviceNode = fixture.serviceNode;
      const replacementNode = path.join(tempDirs.make("replacement-runtime-"), "bin", "node");
      await fs.mkdir(path.dirname(replacementNode), { recursive: true });
      // Preserve the host runtime's dynamic-library paths when metadata probes execute it.
      if (process.platform === "win32") {
        await fs.copyFile(process.execPath, replacementNode);
      } else {
        await fs.writeFile(
          replacementNode,
          `#!/bin/sh\nexec ${quoteCliArg(process.execPath)} "$@"\n`,
          {
            mode: 0o755,
          },
        );
      }
      mockPackageInstallStatus(fixture.root);
      primeServiceCommand([serviceNode, fixture.entrypoint, "gateway"]);
      serviceLoaded.mockResolvedValue(true);
      serviceReadRuntime.mockResolvedValue({
        status: "running",
        pid: gatewayFixturePid,
        state: "running",
      });
      serviceDefinitionMutationCapability.mockResolvedValue({
        kind: capability,
        reason: "fixture",
      });
      primeNpmChannelTag("latest", "2026.7.1");
      vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({ version: "2026.7.1", nodeEngine: ">=26.1.0" }),
      );
      nodeVersionSatisfiesEngine.mockImplementation(
        (version: string | null) => version === "26.8.1",
      );
      resolveNodeRuntimeInfo.mockImplementation(async (nodePath) => ({
        status: "supported",
        version: nodePath === replacementNode ? "26.8.1" : "24.20.0",
        sqliteVersion: "3.51.3",
        nodeSharedSqlite: false,
        sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
      }));
      const recovery = await import("./update-cli/update-command-node-runtime-resolution.js");
      const recoverNode = vi
        .spyOn(recovery, "resolveTargetNodeRuntime")
        .mockResolvedValue(replacementNode);
      mockFileBackedPathExists();
      mockServicePackageCommands({
        nodeModules: fixture.nodeModules,
        packageRoot: fixture.root,
        targetVersion: "2026.7.1",
        npmCommands: ["npm", fixture.serviceNpm, requireValue(fixture.serviceNpmReal, "npm")],
        nodeVersions: {
          [serviceNode]: "v24.20.0",
          [replacementNode]: "v26.8.1",
        },
        onGatewayInstall: (argv) =>
          primeServiceCommand([requireValue(argv[0], "Node"), fixture.entrypoint, "gateway"]),
      });
      if (capability !== "writable") {
        await expect(updateCommand({ yes: true, json: true, restart: true })).rejects.toEqual(
          new ExitError(1),
        );
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "node-runtime-preflight",
        });
        expect(
          commandCalls().find(([argv]) => argv[1] === "i" && argv[2] === "-g"),
        ).toBeUndefined();
        expect(recoverNode).not.toHaveBeenCalled();
        expect(serviceStop).not.toHaveBeenCalled();
        expect((await serviceReadCommand(process.env)).programArguments[0]).toBe(serviceNode);
        expect(
          JSON.parse(await fs.readFile(path.join(fixture.root, "package.json"), "utf8")).version,
        ).toBe("2026.5.18");
      } else {
        await updateCommand({ yes: true, json: true, restart: true });
        expect(commandCalls().find(([argv]) => argv[1] === "i" && argv[2] === "-g")).toBeDefined();
        expect(lastWriteJsonCall()).toMatchObject({ status: "ok" });
        expect((await serviceReadCommand(process.env)).programArguments[0]).toBe(replacementNode);
        expect(recoverNode).toHaveBeenCalledOnce();
      }
    },
  );
});
