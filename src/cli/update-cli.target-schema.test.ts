import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveConfigPath } from "../config/paths.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../infra/update-managed-service-handoff-cleanup.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { VERSION } from "../version.js";
import { waitForCliSignalExit } from "./signal-exit-barrier.js";
import * as check from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as cli from "./update-cli-modules.test-support.js";
import {
  newerAgentSchemaFixture,
  packageTargetStatus,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const {
  defaultRuntime: runtime,
  runCommandWithTimeout: runCommand,
  updateCommand: runUpdate,
  updateGitCheckout: gitUpdate,
} = cli;
const { packageInstallCommandCall: packageInstall } = check;

describe("update-cli", () => {
  const nodeExecutable = resolveTestNodeExecPath();
  const {
    createCaseDir,
    initializeExistingUpdateProfile,
    mockFileBackedPathExists,
    mockGatewayHealth,
    mockNpmGlobalCommands,
    mockNpmGlobalRoot,
    mockOwnedGitService,
    mockPackageInstallAtCaseDir,
    mockPackageInstallStatus,
    mockRunningManagedGateway,
    primeNpmChannelTag,
    primeServiceCommand,
    profileStateDir,
    setupInstalledPackageRoot,
    tempDirs,
    useFileBackedConfig,
    runControlPlaneUpdate,
    setupNpmUpdatedRootRefresh,
    setupUpdatedRootRefresh,
  } = createUpdateCliFixture();

  const profileEnv = (name: string, cwd?: string) => {
    const state = profileStateDir(name);
    return {
      OPENCLAW_PROFILE: name,
      OPENCLAW_STATE_DIR: cwd ? path.relative(cwd, state) : state,
      OPENCLAW_CONFIG_PATH: cwd
        ? path.relative(cwd, path.join(state, "openclaw.json"))
        : path.join(state, "openclaw.json"),
    };
  };

  it.each(["git", "package-to-git", "package-preview"] as const)(
    "refuses a service-only incompatible %s target before any mutable preparation",
    async (kind) => {
      const fixture = createCaseDir(`schema-service-only-${kind}`);
      const { pkgRoot, nodeModules, entryPath } = await setupInstalledPackageRoot(fixture, "1.0.0");
      const root = kind === "git" ? fixture : pkgRoot;
      const destination = path.join(fixture, "checkout");
      let destinationVisibleAtAdmission: boolean | undefined;
      if (kind === "git") {
        await writeOpenClawPackageFixture(root, "1.0.0", { git: true });
        vi.mocked(cli.resolveOpenClawPackageRoot).mockResolvedValue(root);
      } else {
        mockFileBackedPathExists();
        mockNpmGlobalRoot(nodeModules);
      }
      const managedState = profileStateDir("work");
      initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: managedState });
      const callerState = profileStateDir("personal");
      initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: callerState });
      mockOwnedGitService(root);
      if (kind === "package-to-git") {
        mockNpmGlobalCommands(nodeModules, async (argv) => {
          if (argv[0] === "git" && argv[1] === "clone") {
            await writeOpenClawPackageFixture(argv.at(-1)!, "1.0.0", { git: true });
            return commandResult();
          }
          return undefined;
        });
      }
      primeServiceCommand(
        [
          nodeExecutable,
          kind === "git" ? path.join(root, "dist", "index.js") : entryPath,
          "gateway",
          "run",
        ],
        profileEnv("work"),
      );
      mocks.serviceLoaded.mockResolvedValue(true);
      vi.mocked(cli.fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({ schemaVersions: { state: 3, agent: 11 } }),
      );
      if (kind === "git" || kind === "package-to-git") {
        vi.mocked(gitUpdate).mockImplementationOnce(async ({ opts: options }) => {
          destinationVisibleAtAdmission = fsSync.existsSync(destination);
          await check.requireValue(
            options.beforeGitMutation,
            "Git mutation admission",
          )({ schemaVersions: { state: 3, agent: 11 } });
          throw new Error("incompatible service target must not reach Git mutation");
        });
      }
      const inspectedStates: Array<string | undefined> = [];
      mocks.databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(
        ({ env }) => {
          inspectedStates.push(env.OPENCLAW_STATE_DIR);
          return {
            incompatible:
              env.OPENCLAW_STATE_DIR === managedState
                ? [
                    newerAgentSchemaFixture(
                      path.join(
                        env.OPENCLAW_STATE_DIR!,
                        "agents",
                        "worker",
                        "agent",
                        "openclaw-agent.sqlite",
                      ),
                    ),
                  ]
                : [],
            indeterminate: [],
          };
        },
      );
      await withEnvAsync(
        {
          ...profileEnv("personal"),
          OPENCLAW_GIT_DIR: destination,
        },
        async () => {
          if (kind === "package-preview") {
            await runUpdate({ dryRun: true });
            expect(check.getLogOutput()).toContain("Would refuse update: agent database");
            return;
          }
          await expect(
            runUpdate({
              yes: true,
              json: true,
              ...(kind === "package-to-git" ? { channel: "dev" } : {}),
            }),
          ).rejects.toEqual(new cli.ExitError(1));
          expect(check.lastWriteJsonCall()).toMatchObject({
            failedStep: {
              stderrTail: expect.stringContaining(
                `${path.join(managedState, "agents", "worker", "agent", "openclaw-agent.sqlite")} has schema 999; target supports 11`,
              ),
            },
          });
          expect(cli.listUpdateRuns({ limit: 1 })[0]?.reason).toBe("database-schema-preflight");
        },
      );
      expect(inspectedStates).toContain(callerState);
      expect(inspectedStates).toContain(managedState);
      check.expectNoSideEffects(
        mocks.serviceStop,
        mocks.serviceStart,
        mocks.serviceRestart,
        mocks.managedUpdateHandoff.start,
        cleanupStaleManagedServiceUpdateHandoffs,
        mocks.launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
      );
      expect(packageInstall()).toBeUndefined();
      if (kind === "package-to-git") {
        expect(destinationVisibleAtAdmission).toBe(false);
        expect(fsSync.existsSync(destination)).toBe(false);
      }
    },
  );

  it.each(["package metadata", "npm policy", "git metadata", "non-git directory"] as const)(
    "returns verified handoff recovery for a %s refusal",
    async (failure) => {
      const tempDir = tempDirs.make("openclaw-update-handoff-preflight-");
      const { nodeModules } = await setupInstalledPackageRoot(tempDir);
      const gitRoot = path.join(tempDir, "checkout");
      const packageTarget = failure.startsWith("package ");
      mockFileBackedPathExists();
      mockNpmGlobalCommands(nodeModules, async (argv) => {
        if (failure === "npm policy" && argv[0] === "npm" && argv[1] === "--version") {
          return commandResult({ stdout: "unrecognized npm version\n" });
        }
        return undefined;
      });
      if (failure === "non-git directory") {
        await fs.mkdir(gitRoot);
        await fs.writeFile(path.join(gitRoot, "keep.txt"), "operator data\n");
      }
      if (failure === "git metadata") {
        await writeOpenClawPackageFixture(gitRoot, "2026.8.18", { git: true });
        vi.mocked(gitUpdate).mockImplementationOnce(async ({ opts: options }) => {
          await check.requireValue(
            options.beforeGitMutation,
            "Git mutation admission",
          )({ metadataUnreadable: "missing package metadata" });
          throw new Error("refused Git target must not mutate");
        });
      }
      if (failure === "package metadata") {
        vi.mocked(cli.fetchNpmPackageTargetStatus).mockResolvedValue(
          packageTargetStatus({ version: null, error: "registry timeout" }),
        );
      }

      await withEnvAsync(
        { OPENCLAW_UPDATE_RUN_HANDOFF: "1", OPENCLAW_GIT_DIR: gitRoot },
        async () => {
          await expect(
            runUpdate({ channel: packageTarget ? "beta" : "dev", yes: true, json: true }),
          ).rejects.toEqual(new cli.ExitError(1));
        },
      );

      expect(runtime.exit).not.toHaveBeenCalled();
      expect(check.lastWriteJsonCall()).toMatchObject({
        status: "error",
        recovery: { serviceRestartSafe: true },
      });
      expect(packageInstall()?.[0]).toBeUndefined();
      check.expectNoSideEffects(mocks.serviceStop, mocks.serviceRestart, cli.replaceConfigFile);
      if (failure === "non-git directory") {
        await expect(fs.readFile(path.join(gitRoot, "keep.txt"), "utf8")).resolves.toBe(
          "operator data\n",
        );
      }
    },
  );

  it("preserves original state when target metadata resolution is interrupted before admission", async () => {
    await useFileBackedConfig();
    const root = await mockPackageInstallAtCaseDir("openclaw-early-metadata");
    await cli.closeOpenClawStateDatabaseAsync();
    const originalPaths = [
      resolveConfigPath(),
      resolveOpenClawStateSqlitePath(),
      path.join(root, "package.json"),
    ];
    const originals = await Promise.all(originalPaths.map((file) => fs.readFile(file)));
    const requested = createDeferred();
    const release = createDeferred();
    const interruption = new Error("interrupted target metadata request");
    vi.mocked(cli.resolveNpmChannelTag).mockImplementation(async () => {
      requested.resolve();
      await release.promise;
      throw interruption;
    });
    const update = runUpdate({ yes: true, restart: false }).catch((error: unknown) => error);
    try {
      await Promise.race([
        requested.promise,
        update.then(() => {
          throw new Error("Update ended before metadata resolution");
        }),
      ]);
      expect(cli.listUpdateRuns({ limit: 1 })).toEqual([]);
      release.resolve();
      expect(await update).toBe(interruption);
      expect(cli.listUpdateRuns({ limit: 1 })).toEqual([]);
      await cli.closeOpenClawStateDatabaseAsync();
      expect(await Promise.all(originalPaths.map((file) => fs.readFile(file)))).toEqual(originals);
      expect(packageInstall()).toBeUndefined();
      check.expectNoSideEffects(
        mocks.serviceStop,
        cli.replaceConfigFile,
        cleanupStaleManagedServiceUpdateHandoffs,
      );
    } finally {
      release.resolve();
      await update;
    }
  });

  it("settles an admitted update interrupted during plugin preflight (SIGTERM)", async () => {
    await useFileBackedConfig();
    const root = await mockPackageInstallAtCaseDir("openclaw-early-signal");
    const packageBefore = await fs.readFile(path.join(root, "package.json"), "utf8");
    const processOnSpy = vi.spyOn(process, "on");
    const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("update must settle without a forced native exit");
    });
    const requested = createDeferred();
    const pending = createDeferred();
    mocks.pluginAvailabilityPreflight.mockImplementation(async () => {
      requested.resolve();
      await pending.promise;
      throw new Error("interrupted plugin preflight");
    });
    const update = runUpdate({ yes: true, restart: false }).catch((error: unknown) => error);
    try {
      await Promise.race([
        requested.promise,
        update.then(() => {
          throw new Error("Update ended before plugin preflight");
        }),
      ]);
      const before = cli.listUpdateRuns({ limit: 1 })[0]!;
      expect(before.status).toBe("running");
      const listeners = processOnSpy.mock.calls
        .filter(([event]) => event === "SIGTERM")
        .map(([, listener]) => listener);
      expect(listeners.length).toBeGreaterThan(0);
      for (const listener of listeners) {
        listener();
      }
      expect(await waitForCliSignalExit()).toBe(143);
      // Inspect while preflight remains blocked: ordinary unwind cannot settle this row.
      expect(cli.listUpdateRuns({ limit: 1 })[0]).toMatchObject({
        runId: before.runId,
        status: "failed",
        phase: "finished",
        reason: "interrupted",
        finishedAtMs: expect.any(Number),
      });
      expect(process.exitCode).toBe(143);
      expect(processExitSpy).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe(packageBefore);
      expect(packageInstall()).toBeUndefined();
      expect(mocks.serviceStop).not.toHaveBeenCalled();
    } finally {
      pending.resolve();
      await update;
    }
  });

  it("previews explicit artifacts without claiming staged plugin admission", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-local-preview"));
    await runUpdate({ dryRun: true, json: true, tag: "/tmp/candidate.tgz" });
    expect(check.lastWriteJsonCall()).toMatchObject({
      dryRun: true,
      targetVersion: null,
      targetVersionReason: "The package artifact is not staged during a dry-run.",
      notes: expect.arrayContaining([
        expect.stringContaining(
          "Configured plugin availability will be checked against the staged package",
        ),
      ]),
    });
    expect(packageInstall()?.[0]).toBeUndefined();
    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
  });

  it("previews a same-version package override as an explicit artifact update", async () => {
    await mockPackageInstallAtCaseDir("openclaw-same-version-override-preview");
    mocks.readPackageVersion.mockResolvedValue("1.0.0");
    primeNpmChannelTag("latest", "1.0.0");
    vi.mocked(cli.fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ version: "1.0.0" }),
    );
    const packageSpec = "file:/owned/openclaw-current.tgz";

    await withEnvAsync({ OPENCLAW_UPDATE_PACKAGE_SPEC: packageSpec }, async () => {
      await runUpdate({ dryRun: true, json: true, restart: false });
    });

    expect(check.lastWriteJsonCall()).toMatchObject({
      dryRun: true,
      currentVersion: "1.0.0",
      targetVersion: "1.0.0",
      tag: packageSpec,
      actions: expect.arrayContaining([
        `Run global package manager update with spec ${packageSpec}`,
      ]),
    });
    expect(check.lastWriteJsonCall()).not.toHaveProperty("targetVersionReason");
  });

  it("does not write a control-plane sentinel when a dry-run preflight fails", async () => {
    const sentinel = await runControlPlaneUpdate({
      expectedExitCode: 1,
      meta: {
        sessionKey: "agent:main:webchat:dm:user-123",
        handoffId: "extended-stable-dry-run",
        note: "Preview requested from the agent.",
      },
      options: { channel: "extended-stable", dryRun: true, yes: true, json: true },
      beforeUpdate: async () => {
        await mockPackageInstallAtCaseDir();
        vi.mocked(cli.resolveExtendedStablePackage).mockResolvedValueOnce({
          status: "failed",
          reason: "selector_missing",
        });
      },
    });

    expect(sentinel).toBeNull();
    check.expectNoSideEffects(cleanupStaleManagedServiceUpdateHandoffs, runtime.exit);
  });

  it.each([false, true])(
    "reports unavailable plugins without refusing the core update (dryRun=%s)",
    async (dryRun) => {
      const detail =
        'Plugin "example" update availability could not be confirmed before core installation.';
      const sentinel = await runControlPlaneUpdate({
        meta: {
          sessionKey: "agent:main:webchat:dm:user-123",
          handoffId: "plugin-admission",
        },
        options: { dryRun, yes: true, json: true },
        beforeUpdate: async () => {
          await mockPackageInstallAtCaseDir();
          mocks.pluginAvailabilityPreflight.mockResolvedValue([
            { pluginId: "example", reason: detail, message: detail, guidance: [] },
          ]);
        },
      });

      if (dryRun) {
        expect(check.lastWriteJsonCall()).toMatchObject({
          dryRun: true,
          notes: expect.arrayContaining([detail]),
        });
        check.expectNoSideEffects(
          mocks.serviceStop,
          mocks.serviceStart,
          mocks.serviceRestart,
          cli.replaceConfigFile,
        );
        expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
        expect(packageInstall()?.[0]).toBeUndefined();
        expect(sentinel).toBeNull();
      } else {
        expect(check.lastWriteJsonCall()).toMatchObject({ status: "ok", mode: "npm" });
        expect(check.getErrorOutput()).toContain(detail);
        expect(packageInstall()?.[0]).toBeDefined();
        expect(sentinel).toMatchObject({ payload: { status: "ok", stats: { mode: "npm" } } });
      }
    },
  );

  it("preserves control-plane update sentinel consumption on restart health failure", async () => {
    let sentinelConsumed = false;
    const sentinel = await runControlPlaneUpdate({
      expectedExitCode: 1,
      meta: {
        sessionKey: "agent:main:webchat:dm:user-123",
        continuationMessage: "This should not report a successful update.",
      },
      options: { yes: true, json: true },
      beforeUpdate: async () => {
        setupNpmUpdatedRootRefresh();
        mocks.serviceLoaded.mockResolvedValue(true);
        mockGatewayHealth("2026.4.23", "old-gateway");
        const respond = expectDefined(mocks.callGateway.getMockImplementation(), "health response");
        mocks.callGateway.mockImplementation(async (opts) => {
          const current = await cli.readRestartSentinel();
          if (current) {
            sentinelConsumed =
              (await cli.clearRestartSentinelIfRevision(current.revision)) || sentinelConsumed;
          }
          return respond(opts);
        });
      },
    });
    expect(sentinelConsumed).toBe(true);
    expect(sentinel).toBeNull();
    expect(check.gatewayHealthCall()).toMatchObject({
      method: "health",
      scopes: ["operator.read"],
    });
    expect(check.lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "version-mismatch",
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("merges current auth refs with captured service selectors for updated install refresh", async () => {
    const invocationCwd = process.cwd();
    let setup: ReturnType<typeof setupUpdatedRootRefresh> | undefined;
    for (const name of ["personal", "work"]) {
      initializeExistingUpdateProfile({
        ...process.env,
        OPENCLAW_STATE_DIR: profileStateDir(name),
      });
    }
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_AUTH_TOKEN: undefined,
        ...profileEnv("personal", invocationCwd),
        PATH: "/caller/bin",
      },
      async () => {
        setup = setupUpdatedRootRefresh({
          gatewayUpdateImpl: async (root) => {
            process.env.OPENCLAW_GATEWAY_AUTH_TOKEN = "runtime-auth-ref";
            return cli.makeOkUpdateResult({ mode: "npm", root, after: { version: VERSION } });
          },
        });
        primeServiceCommand([process.execPath, setup.entrypoints[0], "gateway", "run"], {
          ...profileEnv("work", invocationCwd),
          PATH: "/service/bin",
        });

        await runUpdate({});
      },
    );

    const entryPath = expectDefined(setup?.entrypoints[0], "updated entrypoint");
    const installEnv = check.gatewayCommandCall(entryPath, "install")?.[1].env as
      | NodeJS.ProcessEnv
      | undefined;
    expect(installEnv).toMatchObject({
      OPENCLAW_GATEWAY_AUTH_TOKEN: "runtime-auth-ref",
      OPENCLAW_STATE_DIR: profileStateDir("work"),
      OPENCLAW_CONFIG_PATH: path.join(profileStateDir("work"), "openclaw.json"),
      PATH: "/service/bin",
    });
  });

  it("reuses captured invocation paths after process.cwd becomes unavailable", async () => {
    const invocationCwd = process.cwd();
    let restoreCwd: (() => void) | undefined;
    const { root, entrypoints } = setupUpdatedRootRefresh({
      gatewayUpdateImpl: async () => {
        const spy = vi.spyOn(process, "cwd").mockImplementation(() => {
          throw new Error("ENOENT: current working directory is gone");
        });
        restoreCwd = () => spy.mockRestore();
        return cli.makeOkUpdateResult({ mode: "npm", root, after: { version: VERSION } });
      },
    });
    try {
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: path.relative(invocationCwd, profileStateDir()),
          OPENCLAW_WORKSPACE_DIR: path.relative(
            invocationCwd,
            path.join(profileStateDir(), "workspace"),
          ),
        },
        () => runUpdate({}),
      );
    } finally {
      restoreCwd?.();
    }
    const entrypoint = check.requireValue(entrypoints[0], "updated entrypoint");
    const install = check.gatewayCommandCall(entrypoint, "install");
    expect(install?.[0][0]).toBe(process.execPath);
    expect(install?.[0].slice(1)).toEqual([
      entrypoint,
      "gateway",
      "install",
      "--force",
      "--port",
      "18789",
      "--json",
      "--update-executor",
      "run",
    ]);
    expect(install?.[1]).toMatchObject({
      cwd: root,
      env: {
        OPENCLAW_STATE_DIR: profileStateDir(),
        OPENCLAW_WORKSPACE_DIR: path.join(profileStateDir(), "workspace"),
      },
    });
    expect(cli.runDaemonInstall).not.toHaveBeenCalled();
  });

  it("keeps the update flag through mutation and restores it after restart", async () => {
    await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: undefined }, async () => {
      const entrypoint = path.join(process.cwd(), "dist", "index.js");
      vi.mocked(cli.resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
      mockRunningManagedGateway([nodeExecutable, entrypoint, "gateway"]);
      cli.mockGitUpdateAfterMutation(cli.makeOkUpdateResult({ root: process.cwd() }));
      const update = check.requireValue(
        vi.mocked(gitUpdate).getMockImplementation(),
        "Git update fixture",
      );
      vi.mocked(gitUpdate).mockImplementationOnce(async (...args) => {
        expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBe("1");
        return update(...args);
      });
      vi.mocked(runtime.log).mockClear();

      await runUpdate({});

      expect(cli.doctorCommand).not.toHaveBeenCalled();
      expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
      const restartIndex = vi
        .mocked(runCommand)
        .mock.calls.findIndex(([argv]) => argv[2] === "gateway" && argv[3] === "restart");
      const restartOrder = check.requireValue(
        vi.mocked(runCommand).mock.invocationCallOrder[restartIndex],
        "installed CLI restart call order",
      );
      const snapshotOrders = mocks.createPreUpdateConfigSnapshotMock.mock.invocationCallOrder;
      expect(mocks.createPreUpdateConfigSnapshotMock).toHaveBeenCalledTimes(1);
      expect(check.requireValue(snapshotOrders[0], "restart snapshot call order")).toBeLessThan(
        restartOrder,
      );

      const successIndex = vi
        .mocked(runtime.log)
        .mock.calls.findIndex((call) => String(call[0]).includes("OpenClaw updated"));
      expect(successIndex).toBeGreaterThanOrEqual(0);
      expect(vi.mocked(runtime.log).mock.invocationCallOrder[successIndex]).toBeGreaterThan(
        restartOrder,
      );
    });
  });
});
