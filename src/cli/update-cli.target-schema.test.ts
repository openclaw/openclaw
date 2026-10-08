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
import {
  expectNoSideEffects,
  freshRestartCalls,
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
  gatewayCommandCall,
  gatewayHealthCall,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import {
  databasePreflightMocks,
  launchdUpdateCleanupMocks,
  managedUpdateHandoff,
  nodeVersionSatisfiesEngine,
  readPackageVersion,
  resolveGlobalManager,
  serviceLoaded,
  serviceRestart,
  serviceStart,
  serviceStop,
  callGateway,
  pluginAvailabilityPreflight,
  createPreUpdateConfigSnapshotMock,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  fetchNpmPackageTargetStatus,
  listUpdateRuns,
  makeOkUpdateResult,
  replaceConfigFile,
  resolveGatewayInstallEntrypoint,
  resolveNpmChannelTag,
  resolveOpenClawPackageRoot,
  runCommandWithTimeout,
  runUpdateFailureTriage,
  doctorCommand,
  mockGitUpdateAfterMutation,
  runDaemonInstall,
  updateCommand,
  updateGitCheckout,
  clearRestartSentinelIfRevision,
  closeOpenClawStateDatabaseAsync,
  readRestartSentinel,
  resolveExtendedStablePackage,
} from "./update-cli-modules.test-support.js";
import { UpdatePreMutationError } from "./update-cli/shared.js";
import {
  newerAgentSchemaFixture,
  packageTargetStatus,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";
import * as runtimeRecovery from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

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
        vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
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
      serviceLoaded.mockResolvedValue(true);
      vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({ schemaVersions: { state: 3, agent: 11 } }),
      );
      if (kind === "git" || kind === "package-to-git") {
        vi.mocked(updateGitCheckout).mockImplementationOnce(async ({ opts: options }) => {
          destinationVisibleAtAdmission = fsSync.existsSync(destination);
          await requireValue(
            options.beforeGitMutation,
            "Git mutation admission",
          )({ schemaVersions: { state: 3, agent: 11 } });
          throw new Error("incompatible service target must not reach Git mutation");
        });
      }
      const inspectedStates: Array<string | undefined> = [];
      databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(({ env }) => {
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
      });
      await withEnvAsync(
        {
          OPENCLAW_PROFILE: "personal",
          OPENCLAW_STATE_DIR: callerState,
          OPENCLAW_CONFIG_PATH: path.join(callerState, "openclaw.json"),
          OPENCLAW_GIT_DIR: destination,
        },
        async () => {
          if (kind === "package-preview") {
            await updateCommand({ dryRun: true });
            expect(getLogOutput()).toContain("Would refuse update: agent database");
            return;
          }
          await expect(
            updateCommand({
              yes: true,
              json: true,
              ...(kind === "package-to-git" ? { channel: "dev" } : {}),
            }),
          ).rejects.toEqual(new ExitError(1));
        },
      );
      expect(inspectedStates).toContain(callerState);
      expect(inspectedStates).toContain(managedState);
      expectNoSideEffects(
        serviceStop,
        serviceStart,
        serviceRestart,
        managedUpdateHandoff.start,
        cleanupStaleManagedServiceUpdateHandoffs,
        launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
      );
      expect(packageInstallCommandCall()).toBeUndefined();
      if (kind === "package-to-git") {
        expect(destinationVisibleAtAdmission).toBe(false);
        expect(fsSync.existsSync(destination)).toBe(false);
      }
    },
  );

  it.each(["absent"] as const)(
    "refuses a newly owned service after an initially %s Git admission snapshot",
    async (initial) => {
      const root = createCaseDir(`new-service-${initial}`);
      await writeOpenClawPackageFixture(root, "1.0.0", { git: true });
      vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
      const managedState = profileStateDir("work");
      let admitted = false;
      databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(({ env }) => ({
        incompatible:
          env.OPENCLAW_STATE_DIR === managedState
            ? [newerAgentSchemaFixture(path.join(managedState, "worker.sqlite"))]
            : [],
        indeterminate: [],
      }));
      vi.mocked(updateGitCheckout).mockImplementationOnce(async ({ opts: options }) => {
        primeServiceCommand(
          [nodeExecutable, path.join(root, "dist", "index.js"), "gateway", "run"],
          {
            OPENCLAW_PROFILE: "work",
            OPENCLAW_STATE_DIR: managedState,
            OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
          },
        );
        serviceLoaded.mockResolvedValue(true);
        await requireValue(
          options.beforeGitMutation,
          "Git mutation admission",
        )({ schemaVersions: { state: 3, agent: 11 } });
        admitted = true;
        return makeOkUpdateResult({ mode: "git", root });
      });
      let failure: unknown;
      try {
        await updateCommand({ yes: true, json: true });
      } catch (error) {
        failure = error;
      }
      expect(admitted).toBe(false);
      expect(failure).toEqual(new ExitError(1));
      expectNoSideEffects(
        serviceStop,
        cleanupStaleManagedServiceUpdateHandoffs,
        launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
      );
      expect(lastWriteJsonCall()).toMatchObject({
        status: "error",
        reason: "managed-service-preflight",
      });
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
      vi.mocked(updateGitCheckout).mockImplementationOnce(async ({ opts: options }) => {
        await requireValue(
          options.beforeGitMutation,
          "Git mutation admission",
        )({ metadataUnreadable: "missing package metadata" });
        throw new Error("refused Git target must not mutate");
      });
    }
    if (failure === "package metadata") {
      vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({ version: null, error: "registry timeout" }),
      );
    }
    if (failure === "package runtime") {
      runtimeRecovery.stubNodeRuntime();
      nodeVersionSatisfiesEngine.mockReturnValue(false);
    }

    await withEnvAsync(
      { OPENCLAW_UPDATE_RUN_HANDOFF: "1", OPENCLAW_GIT_DIR: gitRoot },
      async () => {
        await expect(
          updateCommand({ channel: packageTarget ? "beta" : "dev", yes: true, json: true }),
        ).rejects.toEqual(new ExitError(1));
      },
    );

    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      recovery: { serviceRestartSafe: true },
    });
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expectNoSideEffects(serviceStop, serviceRestart, replaceConfigFile);
    if (failure === "non-git directory") {
      await expect(fs.readFile(path.join(gitRoot, "keep.txt"), "utf8")).resolves.toBe(
        "operator data\n",
      );
    }
  });

  it("preserves original state when target metadata resolution is interrupted before admission", async () => {
    await useFileBackedConfig();
    const root = await mockPackageInstallAtCaseDir("openclaw-early-metadata");
    await closeOpenClawStateDatabaseAsync();
    const originalPaths = [
      resolveConfigPath(),
      resolveOpenClawStateSqlitePath(),
      path.join(root, "package.json"),
    ];
    const originals = await Promise.all(originalPaths.map((file) => fs.readFile(file)));
    const requested = createDeferred();
    const release = createDeferred();
    const interruption = new Error("interrupted target metadata request");
    vi.mocked(resolveNpmChannelTag).mockImplementation(async () => {
      requested.resolve();
      await release.promise;
      throw interruption;
    });
    const update = updateCommand({ yes: true, restart: false }).catch((error: unknown) => error);
    try {
      await Promise.race([
        requested.promise,
        update.then(() => {
          throw new Error("Update ended before metadata resolution");
        }),
      ]);
      expect(listUpdateRuns({ limit: 1 })).toEqual([]);
      release.resolve();
      expect(await update).toBe(interruption);
      expect(listUpdateRuns({ limit: 1 })).toEqual([]);
      await closeOpenClawStateDatabaseAsync();
      expect(await Promise.all(originalPaths.map((file) => fs.readFile(file)))).toEqual(originals);
      expect(packageInstallCommandCall()).toBeUndefined();
      expectNoSideEffects(serviceStop, replaceConfigFile, cleanupStaleManagedServiceUpdateHandoffs);
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
    const exitCalled = createDeferred();
    const processExitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      exitCalled.resolve();
      return undefined as never;
    });
    let entered!: () => void;
    let release!: () => void;
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    pluginAvailabilityPreflight.mockImplementation(async () => {
      entered();
      await pending;
      throw new Error("interrupted plugin preflight");
    });
    const update = updateCommand({ yes: true, restart: false }).catch((error: unknown) => error);
    try {
      await Promise.race([
        requested,
        update.then(() => {
          throw new Error("Update ended before plugin preflight");
        }),
      ]);
      const before = listUpdateRuns({ limit: 1 })[0]!;
      expect(before.status).toBe("running");
      const listeners = processOnSpy.mock.calls
        .filter(([event]) => event === "SIGTERM")
        .map(([, listener]) => listener);
      expect(listeners.length).toBeGreaterThan(0);
      for (const listener of listeners) {
        listener();
      }
      await exitCalled.promise;
      // Inspect while preflight remains blocked: ordinary unwind cannot settle this row.
      expect(listUpdateRuns({ limit: 1 })[0]).toMatchObject({
        runId: before.runId,
        status: "failed",
        phase: "finished",
        reason: "interrupted",
        finishedAtMs: expect.any(Number),
      });
      expect(processExitSpy).toHaveBeenCalledWith(143);
      expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe(packageBefore);
      expect(packageInstallCommandCall()).toBeUndefined();
      expect(serviceStop).not.toHaveBeenCalled();
    } finally {
      release();
      await update;
    }
  });

  it("refuses incompatible inspected runtime requirements when a later lookup disagrees", async () => {
    runtimeRecovery.stubNodeRuntime();
    // This case specifies a non-container system runtime, independent of the test host.
    runtimeRecovery.mockNonContainerSystemRuntime();
    const root = await mockPackageInstallAtCaseDir("openclaw-runtime-target");
    vi.mocked(fetchNpmPackageTargetStatus)
      .mockResolvedValueOnce(packageTargetStatus({ nodeEngine: ">=999.0.0" }))
      .mockResolvedValue(packageTargetStatus({ nodeEngine: ">=22.19.0" }));
    nodeVersionSatisfiesEngine.mockImplementation(
      (_version: string | null, engine: string | null) => engine !== ">=999.0.0",
    );

    await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(new ExitError(1));

    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(listUpdateRuns({ limit: 1 })[0]?.reason).toBe("node-runtime-preflight");
    expect(defaultRuntime.log).toHaveBeenCalledWith(
      `Failing check node-runtime (node-runtime-preflight); key engines.node: Required: openclaw@9999.0.0 Node >=999.0.0; detected: Node ${process.versions.node} at ${process.execPath}
Failing check node-runtime (node-runtime-preflight); key engines.node: Update install root: ${await fs.realpath(root)}
Failing check node-runtime (node-runtime-preflight); key engines.node: Update binary: ${path.join(root, "openclaw.mjs")}
Failing check node-runtime (node-runtime-preflight); key engines.node: Gateway install root: unresolved
Failing check node-runtime (node-runtime-preflight); key engines.node: ${runtimeRecovery.expectedPlainRecovery("9999.0.0", "999.0.0", "absent", undefined, root)}`,
    );
    expect(fetchNpmPackageTargetStatus).toHaveBeenCalledOnce();
  });

  it("previews explicit artifacts without claiming staged plugin admission", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-local-preview"));
    await updateCommand({ dryRun: true, json: true, tag: "/tmp/candidate.tgz" });
    expect(lastWriteJsonCall()).toMatchObject({
      dryRun: true,
      targetVersion: null,
      targetVersionReason: "The package artifact is not staged during a dry-run.",
      notes: expect.arrayContaining([
        expect.stringContaining(
          "Configured plugin availability will be checked against the staged package",
        ),
      ]),
    });
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
  });

  it("previews a same-version package override as an explicit artifact update", async () => {
    await mockPackageInstallAtCaseDir("openclaw-same-version-override-preview");
    readPackageVersion.mockResolvedValue("1.0.0");
    primeNpmChannelTag("latest", "1.0.0");
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ version: "1.0.0" }),
    );
    const packageSpec = "file:/owned/openclaw-current.tgz";

    await withEnvAsync({ OPENCLAW_UPDATE_PACKAGE_SPEC: packageSpec }, async () => {
      await updateCommand({ dryRun: true, json: true, restart: false });
    });

    expect(lastWriteJsonCall()).toMatchObject({
      dryRun: true,
      currentVersion: "1.0.0",
      targetVersion: "1.0.0",
      tag: packageSpec,
      actions: expect.arrayContaining([
        `Run global package manager update with spec ${packageSpec}`,
      ]),
    });
    expect(lastWriteJsonCall()).not.toHaveProperty("targetVersionReason");
  });

  it("does not clean handoffs before rejecting an unknown package owner", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-unknown-owner"));
    const refusal =
      "Update refused: package manager owner is unknown; no changes were made. Run this OpenClaw install through its active npm, pnpm, or Bun global shim, or reinstall it with that package manager, then retry.";
    resolveGlobalManager.mockRejectedValueOnce(
      new UpdatePreMutationError("unmanaged-package-install", refusal),
    );

    await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(new ExitError(0));
    expect([getLogOutput(), getErrorOutput()].join("\n")).toContain(
      refusal.split(", then retry.")[0],
    );

    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(listUpdateRuns({ limit: 1 })[0]).toMatchObject({
      status: "skipped",
      phase: "finished",
      reason: "unmanaged-package-install",
    });
  });

  it("refuses a git target that changes after the service stops", async () => {
    const root = createCaseDir("schema-git");
    const sha = "a".repeat(40);
    await writeOpenClawPackageFixture(root, "1.0.0", {
      git: true,
      builtSha: sha,
      entrySource: "export {};\n",
    });
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
    vi.mocked(runCommandWithTimeout).mockResolvedValue(commandResult({ stdout: sha }));
    mockOwnedGitService(root);
    mockGatewayHealth("1.0.0", "restored", "fixture-original-build");
    const entrypoint = path.join(root, "dist", "index.js");
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);

    serviceLoaded.mockResolvedValue(true);
    vi.mocked(updateGitCheckout).mockImplementationOnce(async ({ opts: options }) => {
      await requireValue(
        options.beforeGitMutation,
        "Git mutation admission",
      )({ schemaVersions: { state: 3, agent: 11 } });
      return makeOkUpdateResult({ mode: "git" });
    });
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(() =>
      serviceStop.mock.calls.length === 0
        ? { incompatible: [], indeterminate: [] }
        : {
            incompatible: [],
            indeterminate: [
              { kind: "agent", path: "/tmp/openclaw-agent.sqlite", reason: "database busy" },
            ],
          },
    );

    await expect(updateCommand({ yes: true, timeout: "17" })).rejects.toEqual(new ExitError(1));

    expect(serviceStop).toHaveBeenCalledOnce();
    const stoppedAt = serviceStop.mock.invocationCallOrder[0]!;
    const schemaCalls =
      databasePreflightMocks.preflightOpenClawDatabaseSchemas.mock.invocationCallOrder;
    expect(schemaCalls.some((order) => order < stoppedAt)).toBe(true);
    expect(schemaCalls.some((order) => order > stoppedAt)).toBe(true);
    expect(freshRestartCalls()).toEqual([
      [
        [
          process.execPath,
          entrypoint,
          "gateway",
          "restart",
          "--preserve-definition",
          "--json",
          "--update-executor",
          "run",
        ],
        expect.objectContaining({ cwd: root, timeoutMs: 17_000, baseEnv: {} }),
      ],
    ]);
    expectNoSideEffects(serviceStart, serviceRestart);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(vi.mocked(runCommandWithTimeout).mock.invocationCallOrder.at(-1)).toBeLessThan(
      requireValue(
        vi.mocked(runUpdateFailureTriage).mock.invocationCallOrder.at(-1),
        "triage after service recovery",
      ),
    );
  });

  it("fails a post-stop git refusal when no managed service was running", async () => {
    vi.mocked(updateGitCheckout).mockImplementationOnce(async ({ opts: options }) => {
      await requireValue(
        options.beforeGitMutation,
        "Git mutation admission",
      )({ schemaVersions: { state: 3, agent: 11 } });
      return makeOkUpdateResult({ mode: "git" });
    });
    databasePreflightMocks.preflightOpenClawDatabaseSchemas
      .mockReturnValueOnce({ incompatible: [], indeterminate: [] })
      .mockReturnValueOnce({
        incompatible: [],
        indeterminate: [{ kind: "state", path: "/tmp/openclaw.sqlite", reason: "database busy" }],
      });

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expectNoSideEffects(serviceStop, serviceRestart);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
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
        vi.mocked(resolveExtendedStablePackage).mockResolvedValueOnce({
          status: "failed",
          reason: "selector_missing",
        });
      },
    });

    expect(sentinel).toBeNull();
    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
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
          pluginAvailabilityPreflight.mockResolvedValue([
            { pluginId: "example", reason: detail, message: detail, guidance: [] },
          ]);
        },
      });

      if (dryRun) {
        expect(lastWriteJsonCall()).toMatchObject({
          dryRun: true,
          notes: expect.arrayContaining([detail]),
        });
        expectNoSideEffects(serviceStop, serviceStart, serviceRestart, replaceConfigFile);
        expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
        expect(packageInstallCommandCall()?.[0]).toBeUndefined();
        expect(sentinel).toBeNull();
      } else {
        expect(lastWriteJsonCall()).toMatchObject({ status: "ok", mode: "npm" });
        expect(getErrorOutput()).toContain(detail);
        expect(packageInstallCommandCall()?.[0]).toBeDefined();
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
        serviceLoaded.mockResolvedValue(true);
        mockGatewayHealth("2026.4.23", "old-gateway");
        const respond = expectDefined(callGateway.getMockImplementation(), "health response");
        callGateway.mockImplementation(async (opts) => {
          const current = await readRestartSentinel();
          if (current) {
            sentinelConsumed =
              (await clearRestartSentinelIfRevision(current.revision)) || sentinelConsumed;
          }
          return respond(opts);
        });
      },
    });
    expect(sentinelConsumed).toBe(true);
    expect(sentinel).toBeNull();
    expect(lastWriteJsonCall()).toMatchObject({ status: "error", reason: "version-mismatch" });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("keeps a core update successful when a plugin cannot load", async () => {
    const { updatedEntrypoint } = setupNpmUpdatedRootRefresh();
    readPackageVersion.mockResolvedValue("2026.4.24");
    serviceLoaded.mockResolvedValue(true);
    mockGatewayHealth("2026.4.23", "previous-gateway");
    const activateGateway = mockPackageGatewayLifecycle();
    const runFixtureCommand = requireValue(
      vi.mocked(runCommandWithTimeout).getMockImplementation(),
      "package command fixture",
    );
    vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
      const result = await runFixtureCommand(argv, options);
      if (
        result.code === 0 &&
        argv[2] === "gateway" &&
        ["install", "restart"].includes(argv[3] ?? "")
      ) {
        await activateGateway(argv);
        const activatedHealth = requireValue(
          callGateway.getMockImplementation(),
          "activated package health",
        );
        // Keep the identity read from the installed package and add the plugin failure after activation.
        callGateway.mockImplementation(async (request) => {
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

    await updateCommand({ yes: true, json: false });

    expect(gatewayCommandCall(updatedEntrypoint, "install")).toBeDefined();
    expect(freshRestartCalls()).toHaveLength(0);
    expect(gatewayHealthCall()).toMatchObject({ method: "health", scopes: ["operator.read"] });
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(getLogOutput()).toContain("Gateway: restarted and verified.");
    expect(getLogOutput()).toContain('Plugin "telegram" could not be loaded.');
    expect(getLogOutput()).toContain("openclaw doctor --fix");
    expect(getLogOutput()).not.toContain("failed to load plugin dependency: ENOSPC");
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
            return makeOkUpdateResult({ mode: "npm", root, after: { version: VERSION } });
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

        await updateCommand({});
      },
    );

    const entryPath = expectDefined(setup?.entrypoints[0], "updated entrypoint");
    const installEnv = gatewayCommandCall(entryPath, "install")?.[1].env as
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
        return makeOkUpdateResult({ mode: "npm", root, after: { version: VERSION } });
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
        () => updateCommand({}),
      );
    } finally {
      restoreCwd?.();
    }
    const entrypoint = requireValue(entrypoints[0], "updated entrypoint");
    const install = gatewayCommandCall(entrypoint, "install");
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
    expect(runDaemonInstall).not.toHaveBeenCalled();
  });

  it("keeps the update flag through mutation and restores it after restart", async () => {
    await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: undefined }, async () => {
      const entrypoint = path.join(process.cwd(), "dist", "index.js");
      vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
      mockRunningManagedGateway([nodeExecutable, entrypoint, "gateway"]);
      mockGitUpdateAfterMutation(makeOkUpdateResult({ root: process.cwd() }));
      const update = requireValue(
        vi.mocked(updateGitCheckout).getMockImplementation(),
        "Git update fixture",
      );
      vi.mocked(updateGitCheckout).mockImplementationOnce(async (...args) => {
        expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBe("1");
        return update(...args);
      });
      vi.mocked(defaultRuntime.log).mockClear();

      await updateCommand({});

      expect(doctorCommand).not.toHaveBeenCalled();
      expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
      const restartIndex = vi
        .mocked(runCommandWithTimeout)
        .mock.calls.findIndex(([argv]) => argv[2] === "gateway" && argv[3] === "restart");
      const restartOrder = requireValue(
        vi.mocked(runCommandWithTimeout).mock.invocationCallOrder[restartIndex],
        "installed CLI restart call order",
      );
      const snapshotOrders = createPreUpdateConfigSnapshotMock.mock.invocationCallOrder;
      expect(createPreUpdateConfigSnapshotMock).toHaveBeenCalledTimes(1);
      expect(requireValue(snapshotOrders[0], "restart snapshot call order")).toBeLessThan(
        restartOrder,
      );

      const successIndex = vi
        .mocked(defaultRuntime.log)
        .mock.calls.findIndex((call) => String(call[0]).includes("OpenClaw updated"));
      expect(successIndex).toBeGreaterThanOrEqual(0);
      expect(vi.mocked(defaultRuntime.log).mock.invocationCallOrder[successIndex]).toBeGreaterThan(
        restartOrder,
      );
    });
  });
});
