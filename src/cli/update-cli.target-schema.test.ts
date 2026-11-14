import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveConfigPath } from "../config/paths.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
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
import { UpdatePreMutationError } from "./update-cli/shared.js";
import {
  newerAgentSchemaFixture,
  packageTargetStatus,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";
import * as runtimeRecovery from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const {
  defaultRuntime: runtime,
  runCommandWithTimeout: runCommand,
  updateCommand: runUpdate,
  updateGitCheckout: gitUpdate,
} = cli;
const { packageInstallCommandCall: packageInstall, freshRestartCalls: restarts } = check;

const { preflightOpenClawDatabaseSchemas } = await vi.importActual<
  typeof import("../state/openclaw-database-preflight.js")
>("../state/openclaw-database-preflight.js");

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
    mockPackageGatewayLifecycle,
    runControlPlaneUpdate,
    setupNpmUpdatedRootRefresh,
    setupUpdatedRootRefresh,
  } = createUpdateCliFixture();

  it("refuses a v2026.7.1-2 target and names every current-schema agent store", async () => {
    await useFileBackedConfig();
    await mockPackageInstallAtCaseDir("schema-published-downgrade");
    const env = process.env;
    const configured = openOpenClawAgentDatabase({ agentId: "main", env }).path;
    const retired = openOpenClawAgentDatabase({ agentId: "retired", env }).path;
    const custom = openOpenClawAgentDatabase({
      agentId: "registered-custom",
      env,
      path: path.join(createCaseDir("custom-agent-store"), "openclaw-agent.sqlite"),
    }).path;
    closeOpenClawAgentDatabasesForTest();
    unregisterOpenClawAgentDatabase({ agentId: "retired", env, path: retired });
    await cli.closeOpenClawStateDatabaseAsync();
    mocks.databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(
      preflightOpenClawDatabaseSchemas,
    );
    vi.mocked(cli.fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ version: "2026.7.1-2", schemaVersions: { state: 1, agent: 1 } }),
    );

    await expect(runUpdate({ tag: "2026.7.1-2", yes: true })).rejects.toEqual(new cli.ExitError(1));

    const output = [check.getLogOutput(), check.getErrorOutput()].join("\n");
    for (const agentPath of [configured, retired, custom]) {
      expect(output).toContain(
        `${agentPath} has schema ${OPENCLAW_AGENT_SCHEMA_VERSION}; target supports 1`,
      );
    }
    expect(cli.listUpdateRuns({ limit: 1 })[0]?.reason).toBe("database-schema-preflight");
    expect(packageInstall()).toBeUndefined();
    check.expectNoSideEffects(
      mocks.serviceStop,
      mocks.serviceStart,
      mocks.serviceRestart,
      cli.replaceConfigFile,
    );
  });

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
        mockFileBackedPathExists();
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
        {
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: managedState,
          OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
        },
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
          OPENCLAW_PROFILE: "personal",
          OPENCLAW_STATE_DIR: callerState,
          OPENCLAW_CONFIG_PATH: path.join(callerState, "openclaw.json"),
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
        },
      );
      expect(inspectedStates).toContain(callerState);
      expect(inspectedStates).toContain(managedState);
      check.expectNoSideEffects(
        mocks.serviceStop,
        mocks.serviceStart,
        mocks.serviceRestart,
        mocks.managedUpdateHandoff.start,
        mocks.launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
      );
      expect(packageInstall()).toBeUndefined();
      if (kind === "package-to-git") {
        expect(destinationVisibleAtAdmission).toBe(false);
        expect(fsSync.existsSync(destination)).toBe(false);
      }
    },
  );

  it.each([
    "package metadata",
    "package runtime",
    "npm policy",
    "clone failure",
    "non-git directory",
    "git metadata",
  ] as const)("returns verified handoff recovery for a %s refusal", async (failure) => {
    const tempDir = tempDirs.make("openclaw-update-handoff-preflight-");
    const { nodeModules } = await setupInstalledPackageRoot(tempDir);
    const gitRoot = path.join(tempDir, "checkout");
    const packageTarget = failure.startsWith("package ");
    mockFileBackedPathExists();
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (failure === "npm policy" && argv[0] === "npm" && argv[1] === "--version") {
        return commandResult({ stdout: "unrecognized npm version\n" });
      }
      if (failure === "clone failure" && argv[0] === "git" && argv[1] === "clone") {
        return commandResult({ code: 128, stderr: "clone unavailable" });
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
    if (failure === "package runtime") {
      runtimeRecovery.stubNodeRuntime();
      mocks.nodeVersionSatisfiesEngine.mockReturnValue(false);
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
  });

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
      check.expectNoSideEffects(mocks.serviceStop, cli.replaceConfigFile);
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

  it("refuses incompatible inspected runtime requirements when a later lookup disagrees", async () => {
    runtimeRecovery.stubNodeRuntime();
    // This case specifies a non-container system runtime, independent of the test host.
    runtimeRecovery.mockNonContainerSystemRuntime();
    const root = await mockPackageInstallAtCaseDir("openclaw-runtime-target");
    vi.mocked(cli.fetchNpmPackageTargetStatus)
      .mockResolvedValueOnce(packageTargetStatus({ nodeEngine: ">=999.0.0" }))
      .mockResolvedValue(packageTargetStatus({ nodeEngine: ">=22.19.0" }));
    mocks.nodeVersionSatisfiesEngine.mockImplementation(
      (_version: string | null, engine: string | null) => engine !== ">=999.0.0",
    );

    await expect(runUpdate({ yes: true, restart: false })).rejects.toEqual(new cli.ExitError(1));

    expect(packageInstall()?.[0]).toBeUndefined();
    expect(cli.listUpdateRuns({ limit: 1 })[0]?.reason).toBe("preflight-node-runtime-incompatible");
    expect(runtime.log).toHaveBeenCalledWith(
      `Failing check node-runtime (node-runtime-preflight); key engines.node: Required: openclaw@9999.0.0 Node >=999.0.0; detected: Node ${process.versions.node} at ${process.execPath}
Failing check node-runtime (node-runtime-preflight); key engines.node: Update install root: ${await fs.realpath(root)}
Failing check node-runtime (node-runtime-preflight); key engines.node: Update binary: ${path.join(root, "openclaw.mjs")}
Failing check node-runtime (node-runtime-preflight); key engines.node: Gateway install root: unresolved
Failing check node-runtime (node-runtime-preflight); key engines.node: ${runtimeRecovery.expectedPlainRecovery("9999.0.0", "999.0.0", "absent", undefined, root)}
Updater Node ${process.versions.node} at ${process.execPath}.
PATH Node: not found.`,
    );
    expect(cli.fetchNpmPackageTargetStatus).toHaveBeenCalledOnce();
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

  it("reports an unknown package owner without installing", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-unknown-owner"));
    const refusal =
      "Update refused: package manager owner is unknown; no changes were made. Run this OpenClaw install through its active npm, pnpm, or Bun global shim, or reinstall it with that package manager, then retry.";
    mocks.resolveGlobalManager.mockRejectedValueOnce(
      new UpdatePreMutationError("unmanaged-package-install", refusal),
    );

    await expect(runUpdate({ yes: true, restart: false })).rejects.toEqual(new cli.ExitError(0));
    expect([check.getLogOutput(), check.getErrorOutput()].join("\n")).toContain(
      refusal.split(", then retry.")[0],
    );

    expect(packageInstall()?.[0]).toBeUndefined();
    expect(cli.listUpdateRuns({ limit: 1 })[0]).toMatchObject({
      status: "skipped",
      phase: "finished",
      reason: "unmanaged-package-install",
    });
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
    check.expectNoSideEffects(runtime.exit);
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
    expect(check.lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "version-mismatch",
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("keeps a core update successful when a plugin cannot load", async () => {
    const { updatedEntrypoint } = setupNpmUpdatedRootRefresh();
    mocks.readPackageVersion.mockResolvedValue("2026.4.24");
    mocks.serviceLoaded.mockResolvedValue(true);
    mockGatewayHealth("2026.4.23", "previous-gateway");
    const activateGateway = mockPackageGatewayLifecycle();
    const runFixtureCommand = check.requireValue(
      vi.mocked(runCommand).getMockImplementation(),
      "package command fixture",
    );
    vi.mocked(runCommand).mockImplementation(async (argv, options) => {
      const result = await runFixtureCommand(argv, options);
      if (
        result.code === 0 &&
        argv[2] === "gateway" &&
        ["install", "restart"].includes(argv[3] ?? "")
      ) {
        await activateGateway(argv);
        const activatedHealth = check.requireValue(
          mocks.callGateway.getMockImplementation(),
          "activated package health",
        );
        // Keep the identity read from the installed package and add the plugin failure after activation.
        mocks.callGateway.mockImplementation(async (request) => {
          await activatedHealth(request);
          return {
            ok: true,
            plugins: {
              errors: [
                {
                  id: "telegram",
                  origin: "bundled",
                  activated: true,
                  error: "failed to load plugin dependency: ENOSPC",
                },
              ],
            },
          };
        });
      }
      return result;
    });

    await runUpdate({ yes: true, json: false });

    expect(check.gatewayCommandCall(updatedEntrypoint, "install")).toBeDefined();
    expect(restarts()).toHaveLength(0);
    expect(check.gatewayHealthCall()).toMatchObject({
      method: "health",
      scopes: ["operator.read"],
    });
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(check.getLogOutput()).toContain("Gateway: restarted and verified.");
    expect(check.getLogOutput()).toContain('Plugin "telegram" could not be loaded.');
    expect(check.getLogOutput()).toContain("openclaw doctor --fix");
    expect(check.getLogOutput()).not.toContain("failed to load plugin dependency: ENOSPC");
  });

  it("merges current auth refs with captured service selectors for updated install refresh", async () => {
    const invocationCwd = process.cwd();
    let setup: ReturnType<typeof setupUpdatedRootRefresh> | undefined;
    initializeExistingUpdateProfile({
      ...process.env,
      OPENCLAW_STATE_DIR: profileStateDir("personal"),
    });
    initializeExistingUpdateProfile({
      ...process.env,
      OPENCLAW_STATE_DIR: profileStateDir("work"),
    });
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_AUTH_TOKEN: undefined,
        OPENCLAW_PROFILE: "personal",
        OPENCLAW_STATE_DIR: path.relative(invocationCwd, profileStateDir("personal")),
        OPENCLAW_CONFIG_PATH: path.relative(
          invocationCwd,
          path.join(profileStateDir("personal"), "openclaw.json"),
        ),
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
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: path.relative(invocationCwd, profileStateDir("work")),
          OPENCLAW_CONFIG_PATH: path.relative(
            invocationCwd,
            path.join(profileStateDir("work"), "openclaw.json"),
          ),
          PATH: "/service/bin",
        });

        await runUpdate({});
      },
    );

    const entryPath = expectDefined(setup?.entrypoints[0], "updated entrypoint");
    const installEnv = check.gatewayCommandCall(entryPath, "install")?.[1].env as
      | NodeJS.ProcessEnv
      | undefined;
    expect(installEnv?.OPENCLAW_GATEWAY_AUTH_TOKEN).toBe("runtime-auth-ref");
    expect(installEnv?.OPENCLAW_STATE_DIR).toBe(profileStateDir("work"));
    expect(installEnv?.OPENCLAW_CONFIG_PATH).toBe(
      path.join(profileStateDir("work"), "openclaw.json"),
    );
    expect(installEnv?.PATH).toBe("/service/bin");
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
      timeoutMs: 30 * 60_000,
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
