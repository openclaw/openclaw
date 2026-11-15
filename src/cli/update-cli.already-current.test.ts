import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { resolveConfigPath } from "../config/paths.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import * as serviceMembership from "../daemon/service-process-membership.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import * as versionManagerPath from "../shared/version-manager-path.js";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION } from "../version.js";
import * as proof from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as modules from "./update-cli-modules.test-support.js";
import {
  mockPostCoreConvergenceOnce,
  postCoreConvergenceResult,
} from "./update-cli/update-cli-config.test-support.js";
import {
  writeJsonFixture,
  writeNpmPackageInstall,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";
import { registerAlreadyCurrentAdmissionTests } from "./update-cli/update-command-current-admission.test-support.js";
import { registerUpdatePreflightTests } from "./update-cli/update-command-preflight.test-support.js";
import * as runtimeRecovery from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const setup = createUpdateCliFixture();
  const { updateCommand, ExitError } = modules;
  async function prepareCurrentPackage(prefix?: string, tag = "latest", rewrite = false) {
    const root = await setup.mockPackageInstallAtCaseDir(prefix, rewrite ? "1.0.0" : VERSION);
    if (rewrite) {
      await writeOpenClawPackageFixture(root, VERSION);
    }
    mocks.readPackageVersion.mockResolvedValue(VERSION);
    setup.primeNpmChannelTag(tag, VERSION);
    return root;
  }
  function serviceArgs(root: string) {
    return ["node", path.join(root, "dist/index.js"), "gateway", "run"];
  }
  async function prepareRunningCurrentPackage(...args: Parameters<typeof prepareCurrentPackage>) {
    const root = await prepareCurrentPackage(...args);
    setup.mockRunningManagedGateway(serviceArgs(root));
    return root;
  }
  const output = () => proof.lastWriteJsonCall() as UpdateRunResult;
  function expectNoServiceMutation(...effects: unknown[]) {
    proof.expectNoSideEffects(
      mocks.serviceStop,
      mocks.serviceRestart,
      modules.runDaemonRestart,
      ...effects,
    );
  }
  function expectNoActivation() {
    expectNoServiceMutation(mocks.candidateValidation);
    expect(proof.packageInstallCommandCall()?.[0]).toBeUndefined();
  }
  async function installRecord(
    prefix: string,
    name: string,
    spec = name,
  ): Promise<PluginInstallRecord> {
    const installPath = setup.createCaseDir(prefix);
    const version = "2026.9.2";
    await fs.mkdir(installPath, { recursive: true });
    await writeJsonFixture(path.join(installPath, "package.json"), { name, version });
    return { source: "npm", spec, installPath, version };
  }
  function pluginOutcome(
    pluginId: string,
    record: PluginInstallRecord,
    changed: boolean,
    message: string,
    versions?: { currentVersion: string; nextVersion: string },
  ) {
    setup.mockNpmPluginOutcomes(
      [{ pluginId, status: changed ? "updated" : "unchanged", message, ...versions }],
      changed,
      {
        ...setup.baseConfig,
        plugins: { ...setup.baseConfig.plugins, installs: { [pluginId]: record } },
      },
    );
  }

  it.each(["stop", "changed owner", "linux"] as const)(
    "converges plugins on an already-current core (%s)",
    async (scenario) => {
      const failure = scenario === "linux" ? undefined : scenario;
      if (scenario === "linux") {
        vi.spyOn(process, "platform", "get").mockReturnValue("linux");
        vi.spyOn(serviceMembership, "inspectServiceProcessMembershipSync").mockReturnValue(
          "absent",
        );
      }
      const root = await prepareRunningCurrentPackage(undefined, "latest", true);
      setup.mockFileBackedPathExists();
      vi.mocked(modules.resolveGatewayInstallEntrypoint).mockReset();
      const record = await installRecord("current-core-plugin", "@openclaw/brave-plugin");
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({ brave: record });
      const updatedRecord = { ...record, version: "2026.9.3" };
      pluginOutcome("brave", updatedRecord, true, "Updated brave: 2026.9.2 -> 2026.9.3.");
      modules.runPostCorePluginConvergenceSpy.mockImplementationOnce(async ({ cfg }) => {
        if (failure === "changed owner") {
          setup.primeServiceCommand([...serviceArgs(root), "--port", "19102"]);
        }
        return {
          ...postCoreConvergenceResult(),
          config: cfg,
          installRecords: { brave: updatedRecord },
        };
      });

      if (failure === "stop") {
        mocks.serviceStop.mockImplementationOnce(async (params: { onMutation?: () => void }) => {
          mocks.serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
          params.onMutation?.();
          throw new Error("listener check failed after stop");
        });
      }
      if (failure) {
        await expect(updateCommand({ yes: true, restart: true, json: true })).rejects.toEqual(
          new ExitError(1),
        );
        expect(mocks.serviceStop).toHaveBeenCalledTimes(failure === "changed owner" ? 0 : 1);
        // The native stop mutation precedes the failed listener check; recovery must start it.
        expect(proof.freshRestartCalls()).toHaveLength(failure === "stop" ? 1 : 0);
        if (failure === "stop") {
          expect(proof.freshRestartCalls()[0]?.[0]).toContain("--preserve-definition");
        }
        expect(proof.packageInstallCommandCall()).toBeUndefined();
        expect(proof.lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "post-update-plugins",
        });
        if (failure === "stop") {
          expect(proof.lastWriteJsonCall()).toHaveProperty(
            "run.verification",
            expect.objectContaining({
              serviceRunning: true,
              readyz: true,
              settled: true,
              recovery: expect.objectContaining({ serviceRestartSafe: true, service: "healthy" }),
            }),
          );
        }
        return;
      }
      await updateCommand({ yes: true, restart: true, json: true });

      expect(proof.lastWriteJsonCall()).toMatchObject({
        status: "ok",
        postUpdate: { plugins: { changed: true } },
      });
      expect(mocks.serviceStop).toHaveBeenCalledTimes(1);
      expect(proof.freshRestartCalls()).toHaveLength(1);
      expect(proof.packageInstallCommandCall()).toBeUndefined();
      expect(mocks.candidateValidation).not.toHaveBeenCalled();
      const message =
        "Service membership unverifiable on this host; using managed stop/update/start.";
      expect(output().steps).toContainEqual(
        expect.objectContaining({
          advisory: { kind: "recoverable-maintenance", message },
        }),
      );
      expect(modules.listUpdateRuns({ limit: 1 })[0]?.steps).toContainEqual(
        expect.objectContaining({
          step: "warning:managed-service-membership",
          status: "completed",
          detail: message,
        }),
      );
      expect(mocks.updateNpmInstalledPlugins.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.serviceStop.mock.invocationCallOrder[0]!,
      );
    },
  );

  registerAlreadyCurrentAdmissionTests({
    ...setup,
    ...proof,
    ...modules,
    prepareCurrentPackage,
    writeServicePackage: (root) =>
      writeOpenClawPackageFixture(root, VERSION, { entrySource: "export {};\n" }),
    resolveConfigPath,
    mocks: { ...mocks, replaceConfigFile: vi.mocked(modules.replaceConfigFile) },
  });

  it("refuses a current Git core with an incompatible before-only version receipt", async () => {
    runtimeRecovery.stubNodeRuntime();
    // This case specifies system-runtime guidance, independent of the host Node manager.
    vi.spyOn(versionManagerPath, "resolveNodeVersionManager").mockReturnValue("system");
    const fixture = runtimeRecovery.currentGitCoreFixture(process.cwd(), VERSION);
    mocks.readPackageVersion.mockResolvedValue(VERSION);
    vi.mocked(modules.updateGitCheckout).mockResolvedValueOnce(fixture.outcome);
    mocks.nodeVersionSatisfiesEngine.mockReturnValue(false);
    vi.mocked(modules.resolveGatewayInstallEntrypoint).mockResolvedValue(
      setup.FRESH_POST_UPDATE_ENTRYPOINT,
    );
    const command = updateCommand({ yes: true, restart: false, json: true });
    await expect(command).rejects.toEqual(new ExitError(1));
    expect(proof.lastWriteJsonCall()).toMatchObject(fixture.runtimeRefusal);
    proof.expectNoSideEffects(mocks.pluginAvailabilityPreflight, mocks.updateNpmInstalledPlugins);
    expectNoServiceMutation();
  });

  it("reports retained pins on an already-current core", async () => {
    await prepareRunningCurrentPackage(undefined, "latest", true);
    const record = await installRecord(
      "current-core-pin",
      "@openclaw/discord",
      "@openclaw/discord@2026.9.2",
    );
    const records = { discord: record };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    const message =
      "discord is pinned to @openclaw/discord@2026.9.2 (installed 2026.9.2); registry latest resolves to 2026.9.3. Pass `openclaw plugins update @openclaw/discord@latest` to replace this version pin.";
    pluginOutcome("discord", record, false, message, {
      currentVersion: "2026.9.2",
      nextVersion: "2026.9.3",
    });
    mockPostCoreConvergenceOnce(modules.runPostCorePluginConvergenceSpy, {
      installRecords: records,
    });

    await updateCommand({ yes: true, json: false });

    expectNoServiceMutation();
    expect(proof.freshRestartCalls()).toHaveLength(0);
    expect(stripAnsi(proof.getLogOutput())).toContain(message);
    expect(mocks.writePersistedInstalledPluginIndexInstallRecordsWithLease).not.toHaveBeenCalled();
    expect(records.discord?.spec).toBe("@openclaw/discord@2026.9.2");
  });

  it.each(["inside", "descendant"] as const)(
    "never stages or stops an unchanged managed gateway under auto admission (membership=%s)",
    async (membership) => {
      await prepareRunningCurrentPackage("openclaw-current-package");
      vi.spyOn(serviceMembership, "inspectServiceProcessMembershipSync").mockReturnValue("inside");
      if (membership === "descendant") {
        mocks.mockGetSelfAndAncestorPidsSync.mockReturnValue(
          new Set([process.pid, mocks.gatewayFixturePid, 1]),
        );
      }

      await updateCommand({ admission: "auto", yes: true, restart: true, json: true });

      expectNoActivation();
      expect(mocks.managedUpdateHandoff.start).not.toHaveBeenCalled();
      proof.expectNoSideEffects(
        mocks.updateNpmInstalledPlugins,
        mocks.syncPluginsForUpdateChannel,
        mocks.systemdPolicy,
      );
      const result = output();
      expect(result).toMatchObject({
        status: "skipped",
        reason: "already-current",
        steps: expect.arrayContaining([
          expect.objectContaining({
            exitCode: 0,
            advisory: {
              kind: "recoverable-maintenance",
              message: expect.stringContaining(
                "plugin, runtime, and service maintenance was deferred",
              ),
            },
          }),
          expect.objectContaining({ name: "recovery-artifact-cleanup", exitCode: 0 }),
        ]),
      });
      expect(
        result.steps.find((step) => step.name === "recovery-artifact-cleanup")?.advisory,
      ).toBeUndefined();
      expect(modules.replaceConfigFile).not.toHaveBeenCalled();
      expect(modules.getUpdateRun(proof.requireValue(result.runId, "no-op run id"))).toMatchObject({
        status: "skipped",
        reason: "already-current",
        downtimeMs: 0,
      });
    },
  );

  it.each(["outside", "unknown"] as const)(
    "reports the outcome of a same-version channel switch (%s)",
    async (membership) => {
      const root = await prepareCurrentPackage("openclaw-current-package", "beta");
      const stateDir = setup.profileStateDir();
      setup.initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
      const config = { update: { channel: "stable" as const } };
      vi.mocked(modules.readConfigFileSnapshot).mockResolvedValue(setup.configSnapshot(config));
      await writeJsonFixture(path.join(stateDir, "openclaw.json"), config);
      setup.mockRunningManagedGateway(serviceArgs(root));
      vi.spyOn(serviceMembership, "inspectServiceProcessMembershipSync").mockReturnValue(
        membership,
      );

      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_DEBUG_PROXY_ENABLED: membership === "outside" ? "yes" : "0",
          OPENCLAW_DEBUG_PROXY_URL: undefined,
          OPENCLAW_DEBUG_PROXY_REQUIRE: undefined,
        },
        () =>
          updateCommand({
            admission: "auto",
            channel: "beta",
            yes: true,
            restart: true,
            json: true,
          }),
      );

      expectNoActivation();
      const captureNotice =
        "Warning: Debug HTTP capture is disabled in this updater process. Doctor may enable capture in its own process after schema readiness is confirmed.";
      expect(proof.getErrorOutput().includes(captureNotice)).toBe(membership === "outside");
      if (membership === "unknown") {
        proof.expectNoSideEffects(modules.replaceConfigFile, mocks.updateNpmInstalledPlugins);
        expect(proof.lastWriteJsonCall()).toMatchObject({
          status: "skipped",
          reason: "already-current",
        });
        expect(proof.getErrorOutput()).toContain(
          "Requested channel change to beta was not applied; retry with --channel beta.",
        );
        expect(
          JSON.parse(await fs.readFile(path.join(stateDir, "openclaw.json"), "utf8")),
        ).toMatchObject({ update: { channel: "stable" } });
        return;
      }
      expect(proof.lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("beta");
      const result = output();
      expect(result).toMatchObject({ status: "ok" });
      expect(result).not.toHaveProperty("reason");
      expect(
        modules.getUpdateRun(proof.requireValue(result.runId, "channel switch run id"), {
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }),
      ).toMatchObject({ status: "succeeded", downtimeMs: 0 });
    },
  );

  it("completes an equal-version Git-to-package switch", async () => {
    const { nodeModules, pkgRoot } = await setup.setupInstalledPackageRoot(
      setup.createCaseDir("openclaw-git-to-package-same-version"),
      VERSION,
    );
    await fs.writeFile(path.join(pkgRoot, "dist", "index.js"), "git runtime\n");
    await writePackageDistInventory(pkgRoot);
    setup.mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] !== "npm" || argv[1] !== "i") {
        return;
      }
      await writeNpmPackageInstall(argv, pkgRoot, VERSION);
      const stagePrefix = proof.requireValue(argv[argv.indexOf("--prefix") + 1], "staged prefix");
      const stageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
      await fs.writeFile(path.join(stageRoot, "dist", "index.js"), "package runtime\n");
      await writePackageDistInventory(stageRoot);
    });
    setup.mockCurrentProcessFreshDoctor({ packageRoot: pkgRoot });
    vi.mocked(modules.resolveUpdateInstallKind).mockResolvedValue("git");
    vi.mocked(modules.resolveUpdateInstallIdentity).mockResolvedValue({
      installKind: "git",
      git: { tag: `v${VERSION}`, branch: "main" },
    });
    mocks.readPackageVersion.mockImplementation(async (root: string) => {
      const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
        version: string;
      };
      return manifest.version;
    });
    setup.primeNpmChannelTag("latest", VERSION);
    vi.mocked(modules.readConfigFileSnapshot).mockResolvedValue(
      setup.configSnapshot({ update: { channel: "dev" } }),
    );

    await updateCommand({ channel: "stable", yes: true, restart: false, json: true });

    proof.expectPackageInstallSpec(`openclaw@${VERSION}`);
    expect(mocks.candidateValidation).toHaveBeenCalled();
    await expect(fs.readFile(path.join(pkgRoot, "dist", "index.js"), "utf8")).resolves.toBe(
      "package runtime\n",
    );
    expect(proof.lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("stable");
    expect(output()).toMatchObject({
      status: "ok",
      mode: "npm",
      root: pkgRoot,
    });
    expect(output().reason).toBeUndefined();
  });

  it.each(["latest", "next"] as const)("handles an unresolved %s dist-tag lookup", async (tag) => {
    setup.setTty(false);
    await setup.mockPackageInstallAtCaseDir();
    mocks.readPackageVersion.mockResolvedValue("2026.4.22");
    if (tag === "latest") {
      setup.primeNpmChannelTag(tag, null);
      await updateCommand({});

      expect(proof.getErrorOutput()).not.toContain("Downgrade confirmation required.");
      expect(modules.defaultRuntime.exit).not.toHaveBeenCalled();
      proof.expectPackageInstallSpec("openclaw@latest");
      expect(
        vi.mocked(modules.runExec).mock.calls.filter(([, args]) => args[1] === "doctor"),
      ).toEqual([]);
      return;
    }
    vi.mocked(modules.fetchNpmTagVersion).mockResolvedValue({
      tag,
      version: null,
      error: "HTTP 404",
    });

    await expect(updateCommand({ tag })).rejects.toEqual(new ExitError(1));

    expect(proof.getLogOutput()).toContain(
      "OpenClaw update skipped: downgrade-confirmation-required.",
    );
    expect(proof.getLogOutput()).toContain(
      "Downgrade confirmation required.\nDowngrading can break configuration. Re-run in a TTY to confirm.",
    );
    expect(proof.packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(proof.doctorCommandCall()).toBeUndefined();
    expectNoServiceMutation(mocks.serviceStart, modules.replaceConfigFile);
  });

  registerUpdatePreflightTests({
    ...setup,
    ...proof,
    ...modules,
    retainUpdateRuntime: mocks.retainUpdateRuntime,
    makeTempDir: (prefix) => setup.tempDirs.make(prefix),
  });
});
