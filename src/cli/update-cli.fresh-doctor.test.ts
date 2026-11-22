import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { recordCommandProcessFailure } from "../process/exec-result.js";
import {
  commandCalls,
  expectNoSideEffects,
  getErrorOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
  getLogOutput,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as update from "./update-cli-modules.test-support.js";
import { packageTargetStatus } from "./update-cli/update-cli-package.test-support.js";
import { runtimeFixture } from "./update-cli/update-command-fixtures.test-support.js";
import * as runtimeRecovery from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const f = createUpdateCliFixture();

  it("checks original Git version before a dry-run package downgrade", async () => {
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
    expectNoSideEffects(update.updateGitRelease, update.replaceConfigFile, mocks.spawn);
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
    const message = result.pluginUpdate.warnings?.at(-1)?.message;
    expect(message).toMatch(/^[^\n]*update repair`[^]*process failed[^]*diagnostic output/u);
    expect(message).not.toContain("long-argv-prefix");
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

  it("preserves split-root package updates when service environment overrides cannot be inspected", async () => {
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
      managedOverrides: { environment: true },
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
    expect(installCalls).toHaveLength(0);
    expect(mocks.serviceStop).toHaveBeenCalledOnce();
    expect(getLogOutput()).toContain("Gateway: restarted and verified");
  });

  it.each([{ capability: "sealed" }, { capability: "writable" }] as const)(
    "refuses incompatible registry targets before mutating a $capability service launcher",
    async ({ capability }) => {
      const fixture = await f.setupServicePackageAtPrefix({
        prefix: f.tempDirs.make("preserved-runtime-"),
      });
      const serviceNode = fixture.serviceNode;
      f.mockPackageInstallStatus(fixture.root);
      mockRunningService([serviceNode, fixture.entrypoint, "gateway"], capability);
      f.primeNpmChannelTag("latest", "2026.7.1");
      vi.mocked(update.fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({ version: "2026.7.1", nodeEngine: ">=26.12.1" }),
      );
      mocks.nodeVersionSatisfiesEngine.mockImplementation(
        (version: string | null) => version === "26.12.1",
      );
      mocks.resolveNodeRuntimeInfo.mockResolvedValue(runtimeFixture("24.20.0"));
      const recovery = await import("./update-cli/update-command-node-runtime-resolution.js");
      const recoverNode = vi
        .spyOn(recovery, "resolveTargetNodeRuntime")
        .mockResolvedValue(undefined);
      f.mockFileBackedPathExists();
      f.mockServicePackageCommands({
        nodeModules: fixture.nodeModules,
        packageRoot: fixture.root,
        targetVersion: "2026.7.1",
        npmCommands: ["npm", fixture.serviceNpm, requireValue(fixture.serviceNpmReal, "npm")],
        nodeVersions: {
          [serviceNode]: "v24.20.0",
        },
      });
      await expect(update.updateCommand({ yes: true, json: true, restart: true })).rejects.toEqual(
        new update.ExitError(1),
      );
      expect(lastWriteJsonCall()).toMatchObject({
        status: "error",
        reason: "preflight-node-runtime-incompatible",
      });
      expect(packageInstallCommandCall()?.[0]).toBeUndefined();
      expectNoSideEffects(mocks.serviceStop);
      if (capability === "writable") {
        expect(recoverNode).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            engine: ">=26.12.1",
            recovery: { env: expect.any(Object) },
          }),
        );
      } else {
        expect(recoverNode).not.toHaveBeenCalled();
      }
      expect((await mocks.serviceReadCommand(process.env)).programArguments[0]).toBe(serviceNode);
      expect(await installedVersion(fixture.root)).toBe("2026.5.18");
    },
  );
});
