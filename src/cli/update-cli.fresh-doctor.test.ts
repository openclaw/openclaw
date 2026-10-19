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
import * as mocks from "./update-cli-mocks.test-support.js";
import * as update from "./update-cli-modules.test-support.js";
import { registerForegroundFailureRecoveryTests } from "./update-cli/update-cli-failure-recovery.test-support.js";
import {
  writeGitUpdateResultFixture,
  packageTargetStatus,
} from "./update-cli/update-cli-package.test-support.js";
import * as runtimeRecovery from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const f = createUpdateCliFixture();

  it("carries explicit capability consent into post-core plugin convergence", async () => {
    const { entrypoints } = f.setupUpdatedRootRefresh({
      gatewayUpdateImpl: (root) =>
        writeGitUpdateResultFixture({
          root,
          before: { sha: "old-sha", version: "2026.4.26" },
          after: { sha: "new-sha", version: VERSION },
        }),
    });
    const runOtherCommand = requireValue(
      vi.mocked(update.runExec).getMockImplementation(),
      "update command fixture",
    );
    vi.mocked(update.runExec).mockImplementation(async (command, args, options) => {
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

    await update.updateCommand({ acceptCapabilities: true, yes: true, restart: false });

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

  it("checks original Git version before a dry-run package downgrade", async () => {
    vi.mocked(update.resolveOpenClawPackageRoot).mockResolvedValue(
      f.createCaseDir("openclaw-git-downgrade"),
    );
    mocks.readPackageVersion.mockResolvedValue("2026.9.3-beta.1");
    f.primeNpmChannelTag("latest", "2026.9.1");
    await update.updateCommand({ channel: "stable", json: true, dryRun: true });
    expect(lastWriteJsonCall()).toMatchObject({
      currentVersion: "2026.9.3-beta.1",
      targetVersion: "2026.9.1",
      downgradeRisk: true,
      switchToPackage: true,
    });
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expectNoSideEffects(update.updateGitCheckout, update.replaceConfigFile, mocks.spawn);
  });

  it("pins the compatibility host version to the downgraded target during current-process post-core plugin convergence (#87914)", async () => {
    const downgradedRoot = f.createCaseDir("openclaw-downgraded-compat-root");
    vi.mocked(update.resolveUpdateInstallKind).mockImplementation(async (root) =>
      root === downgradedRoot ? "package" : "git",
    );
    f.setupUpdatedRootRefresh({
      targetVersion: "2026.4.10",
      gatewayUpdateImpl: async () =>
        update.makeOkUpdateResult({
          mode: "npm",
          root: downgradedRoot,
          before: { version: "2026.4.14" },
          after: { version: "2026.4.10" },
        }),
    });
    // Convergence must use the target root's version, not the still-running core.
    mocks.readPackageVersion.mockImplementation(async (pkgRoot: string) =>
      pkgRoot === downgradedRoot ? "2026.4.10" : "2026.4.14",
    );
    f.primeNpmChannelTag("latest", "2026.4.10");

    delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    f.mockCurrentProcessFreshDoctor({ postCoreResumeAttempt: false });
    let hostVersionDuringPluginUpdate: string | undefined = "unset";
    mocks.updateNpmInstalledPlugins.mockImplementation(async () => {
      hostVersionDuringPluginUpdate = process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
      return { changed: false, config: f.baseConfig, outcomes: [] };
    });

    try {
      await update.updateCommand({ yes: true, tag: "2026.4.10", restart: false });

      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
      expect(hostVersionDuringPluginUpdate).toBe("2026.4.10");
      expect(update.runPostCorePluginConvergenceSpy).toHaveBeenCalledWith(
        expect.objectContaining({ compatibilityHostVersion: "2026.4.10" }),
      );
      expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
    } finally {
      delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    }
  });

  it("runs updated plugin migrations for a plugin-only current-process update", async () => {
    // This path exercises delegated Doctor ownership, independent of repository build artifacts.
    vi.spyOn(update.doctorChild, "inspectUpdateDoctorChildSupport").mockResolvedValue(true);
    mocks.readPackageVersion.mockResolvedValue(VERSION);
    vi.mocked(update.updateGitCheckout).mockResolvedValue(
      runtimeRecovery.currentGitCoreFixture(process.cwd(), VERSION).outcome,
    );
    vi.mocked(update.resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      f.FRESH_POST_UPDATE_ENTRYPOINT,
    );
    f.mockNpmPluginOutcomes([], true);
    let strictValidationEnv: string | undefined;
    vi.mocked(update.readConfigFileSnapshot).mockImplementation(async (options) => {
      if (!options?.skipPluginValidation) {
        strictValidationEnv = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
      }
      return f.baseSnapshot;
    });

    await update.updateCommand({ yes: true, restart: false });

    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(update.resolveGatewayInstallEntrypoint).toHaveBeenCalledTimes(1);
    const doctorCalls = commandCalls().filter(([argv]) => argv.at(-1) === "--doctor");
    expect(doctorCalls).toHaveLength(1);
    update.expectDelegatedPluginDoctorInput(doctorCalls[0]?.[1].input);
    expect(
      vi
        .mocked(update.runExec)
        .mock.calls.filter(([, args]) => args[0] === f.FRESH_POST_UPDATE_ENTRYPOINT),
    ).toEqual([
      [
        expect.any(String),
        [f.FRESH_POST_UPDATE_ENTRYPOINT, "config", "validate", "--json"],
        expect.objectContaining({ env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" } }),
      ],
    ]);
    expect(strictValidationEnv).toBe("0");
    expect(update.defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("records diagnostics as a warning when the fresh plugin doctor cannot run", async () => {
    vi.mocked(update.resolveGatewayInstallEntrypoint).mockResolvedValueOnce(
      f.FRESH_POST_UPDATE_ENTRYPOINT,
    );
    vi.mocked(update.runUtf8CommandWithTimeout).mockRejectedValueOnce(
      recordCommandProcessFailure(
        Object.assign(new Error("Command failed: " + "long-argv-prefix ".repeat(100)), {
          stderr: "doctor process failed: optional plugin repair unavailable",
          stdout: "doctor diagnostic output",
        }),
        { code: 1, cleanup: "normal", termination: "exit" },
      ),
    );
    const result = await f.completeChangedPostCorePluginUpdate();

    expect(result.pluginUpdate).toMatchObject({
      status: "warning",
      reason: "post-plugin-doctor-execution-failed",
    });
    expect(result.pluginUpdate.warnings?.at(-1)?.message).toContain("doctor process failed");
    expect(result.pluginUpdate.warnings?.at(-1)?.message).toContain("doctor diagnostic output");
    expect(result.pluginUpdate.warnings?.at(-1)?.message).not.toContain("long-argv-prefix");
  });

  registerForegroundFailureRecoveryTests({
    setupUpdatedRootRefresh: f.setupUpdatedRootRefresh,
    spawn: mocks.spawn,
    updateCommand: update.updateCommand,
    defaultRuntime: update.defaultRuntime,
    ExitError: update.ExitError,
    spawnCall,
    lastWriteJsonCall,
    updateNpmInstalledPlugins: mocks.updateNpmInstalledPlugins,
  });
});

describe("update-cli", () => {
  const f = createUpdateCliFixture();

  beforeEach(() => runtimeRecovery.stubNodeRuntime());

  const installedVersion = async (root: string) =>
    JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version;
  const mockRunningService = (argv: string[], kind: "sealed" | "writable", reason = "fixture") => {
    f.primeServiceCommand(argv);
    mocks.serviceLoaded.mockResolvedValue(true);
    mocks.serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: mocks.gatewayFixturePid,
      state: "running",
    });
    mocks.serviceDefinitionMutationCapability.mockResolvedValue({ kind, reason });
  };

  it("preserves split-root package updates when the service definition is writable-overridden", async () => {
    const oldInstall = await f.setupServicePackageAtPrefix({
      prefix: f.tempDirs.make("sealed-node-a-"),
    });
    const shellInstall = await f.setupServicePackageAtPrefix({
      prefix: f.tempDirs.make("sealed-node-b-"),
    });
    f.mockPackageInstallStatus(shellInstall.root);
    mocks.readPackageVersion.mockImplementation(installedVersion);
    const originalCommand = [oldInstall.serviceNode, oldInstall.entrypoint, "gateway"];
    mockRunningService(originalCommand, "writable", "inspection-failed");
    const overriddenCommand = {
      programArguments: originalCommand,
      environment: { NODE_OPTIONS: "--max-old-space-size=4096" },
      managedDefinition: { programArguments: originalCommand },
      managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } },
    };
    mocks.serviceReadCommand.mockResolvedValue(overriddenCommand);
    f.primeNpmChannelTag("latest", "2026.5.20");
    f.mockFileBackedPathExists();
    const transports = [oldInstall, shellInstall].map((install) => {
      f.mockServicePackageCommands({
        nodeModules: install.nodeModules,
        packageRoot: install.root,
        targetVersion: "2026.5.20",
        npmCommands: ["npm", install.serviceNpm, requireValue(install.serviceNpmReal, "npm")],
        nodeVersions: { [oldInstall.serviceNode]: "v24.19.0" },
      });
      return requireValue(
        vi.mocked(update.runCommandWithTimeout).getMockImplementation(),
        "package transport",
      );
    });
    const oldPrefix = path.dirname(path.dirname(oldInstall.serviceNode));
    vi.mocked(update.runCommandWithTimeout).mockImplementation((argv, options) => {
      const context =
        typeof options === "object" && options !== null
          ? [options.cwd ?? "", options.env?.PATH ?? ""]
          : [];
      const old = [...argv, ...context].some((value) => value.includes(oldPrefix));
      return transports[old ? 0 : 1]!(argv, options);
    });
    await update.updateCommand({ yes: true }).catch((cause: unknown) => {
      throw new Error(getErrorOutput() + getLogOutput(), { cause });
    });
    expect(await installedVersion(oldInstall.root)).toBe("2026.5.20");
    expect(await installedVersion(shellInstall.root)).toBe("2026.5.18");
    expect(await mocks.serviceReadCommand(process.env)).toEqual(overriddenCommand);
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
    expect(mocks.serviceStop).toHaveBeenCalledOnce();
    expect(getLogOutput()).toContain("Gateway: restarted and verified");
  });

  it.each([{ capability: "sealed" }, { capability: "writable" }] as const)(
    "preserves target compatibility for an unchanged service launcher ($capability)",
    async ({ capability }) => {
      const fixture = await f.setupServicePackageAtPrefix({
        prefix: f.tempDirs.make("preserved-runtime-"),
      });
      const serviceNode = fixture.serviceNode;
      const replacementNode = path.join(f.tempDirs.make("replacement-runtime-"), "bin", "node");
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
      f.mockPackageInstallStatus(fixture.root);
      mockRunningService([serviceNode, fixture.entrypoint, "gateway"], capability);
      f.primeNpmChannelTag("latest", "2026.7.1");
      vi.mocked(update.fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({ version: "2026.7.1", nodeEngine: ">=26.1.0" }),
      );
      mocks.nodeVersionSatisfiesEngine.mockImplementation(
        (version: string | null) => version === "26.8.1",
      );
      mocks.resolveNodeRuntimeInfo.mockImplementation(async (nodePath) => ({
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
      f.mockFileBackedPathExists();
      f.mockServicePackageCommands({
        nodeModules: fixture.nodeModules,
        packageRoot: fixture.root,
        targetVersion: "2026.7.1",
        npmCommands: ["npm", fixture.serviceNpm, requireValue(fixture.serviceNpmReal, "npm")],
        nodeVersions: {
          [serviceNode]: "v24.20.0",
          [replacementNode]: "v26.8.1",
        },
        onGatewayInstall: (argv) =>
          f.primeServiceCommand([requireValue(argv[0], "Node"), fixture.entrypoint, "gateway"]),
      });
      if (capability !== "writable") {
        await expect(
          update.updateCommand({ yes: true, json: true, restart: true }),
        ).rejects.toEqual(new update.ExitError(1));
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "node-runtime-preflight",
        });
        expect(
          commandCalls().find(([argv]) => argv[1] === "i" && argv[2] === "-g"),
        ).toBeUndefined();
        expectNoSideEffects(recoverNode, mocks.serviceStop);
        expect((await mocks.serviceReadCommand(process.env)).programArguments[0]).toBe(serviceNode);
        expect(await installedVersion(fixture.root)).toBe("2026.5.18");
      } else {
        await update.updateCommand({ yes: true, json: true, restart: true });
        expect(commandCalls().find(([argv]) => argv[1] === "i" && argv[2] === "-g")).toBeDefined();
        expect(lastWriteJsonCall()).toMatchObject({ status: "ok" });
        expect((await mocks.serviceReadCommand(process.env)).programArguments[0]).toBe(
          replacementNode,
        );
        expect(recoverNode).toHaveBeenCalledOnce();
      }
    },
  );
});
