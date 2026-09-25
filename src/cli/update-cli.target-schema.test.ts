import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../infra/update-managed-service-handoff-cleanup.js";
import * as versionManagerPath from "../shared/version-manager-path.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import {
  expectNoSideEffects,
  freshRestartCalls,
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
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
  serviceReadRuntime,
  serviceRestart,
  serviceStart,
  serviceStop,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  expectGitMetadataPreview,
  fetchNpmPackageTargetStatus,
  listUpdateRuns,
  makeOkUpdateResult,
  replaceConfigFile,
  resolveGatewayInstallEntrypoint,
  resolveNpmChannelTag,
  resolveOpenClawPackageRoot,
  runCommandWithTimeout,
  runUpdateFailureTriage,
  updateCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import {
  packageTargetStatus,
  writeOpenClawPackageFixture,
} from "./update-cli/update-cli-package.test-support.js";
import * as runtimeRecovery from "./update-cli/update-command-runtime-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
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
  } = createUpdateCliFixture();

  it.each([
    { kind: "package", callerIncompatible: false },
    { kind: "git", callerIncompatible: false },
    { kind: "package-to-git", callerIncompatible: false },
    { kind: "package-preview", callerIncompatible: false },
    { kind: "package", callerIncompatible: true },
    { kind: "package-stopped", callerIncompatible: false },
  ] as const)(
    "refuses a service-only incompatible $kind target before any mutable preparation, callerIncompatible=$callerIncompatible",
    async ({ kind, callerIncompatible }) => {
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
          "node",
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
      if (kind === "package-stopped") {
        serviceLoaded.mockResolvedValue(false);
        serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      }
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
            env.OPENCLAW_STATE_DIR === managedState || callerIncompatible
              ? [
                  {
                    kind: "agent",
                    path: path.join(
                      env.OPENCLAW_STATE_DIR!,
                      "agents",
                      "worker",
                      "agent",
                      "openclaw-agent.sqlite",
                    ),
                    foundVersion: 999,
                    supportedVersion: 11,
                  },
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
              ...(kind === "package-stopped" ? { restart: false } : {}),
            }),
          ).rejects.toEqual(new ExitError(1));
        },
      );
      expect(inspectedStates).toContain(callerState);
      expect(inspectedStates).toContain(managedState);
      if (callerIncompatible) {
        expect(getErrorOutput()).toContain(
          path.join(callerState, "agents", "worker", "agent", "openclaw-agent.sqlite"),
        );
        expect(getErrorOutput()).toContain(
          path.join(managedState, "agents", "worker", "agent", "openclaw-agent.sqlite"),
        );
      }
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

  it.each(["absent", "foreign"] as const)(
    "refuses a newly owned service after an initially %s Git admission snapshot",
    async (initial) => {
      const root = createCaseDir(`new-service-${initial}`);
      await writeOpenClawPackageFixture(root, "1.0.0", { git: true });
      vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue(root);
      if (initial === "foreign") {
        const foreignRoot = createCaseDir("foreign-service-root");
        const foreignEntry = await writeOpenClawPackageFixture(foreignRoot, "1.0.0");
        mockRunningManagedGateway(["node", foreignEntry, "gateway", "run"]);
      }
      const managedState = profileStateDir("work");
      let admitted = false;
      databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(({ env }) => ({
        incompatible:
          env.OPENCLAW_STATE_DIR === managedState
            ? [
                {
                  kind: "agent",
                  path: path.join(managedState, "worker.sqlite"),
                  foundVersion: 999,
                  supportedVersion: 11,
                },
              ]
            : [],
        indeterminate: [],
      }));
      vi.mocked(updateGitCheckout).mockImplementationOnce(async ({ opts: options }) => {
        primeServiceCommand(["node", path.join(root, "dist", "index.js"), "gateway", "run"], {
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: managedState,
          OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
        });
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

  it("preserves best-effort preview when target metadata is unavailable", async () => {
    await updateCommand({ dryRun: true, json: true });
    expectGitMetadataPreview(lastWriteJsonCall());
    expectNoSideEffects(
      updateGitCheckout,
      serviceStop,
      cleanupStaleManagedServiceUpdateHandoffs,
      launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
    expect(packageInstallCommandCall()).toBeUndefined();
  });

  it.each([
    "package metadata",
    "package schema",
    "package runtime",
    "npm policy",
    "clone failure",
    "non-git directory",
    "git metadata",
    "git schema",
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
    if (failure.startsWith("git ")) {
      await writeOpenClawPackageFixture(gitRoot, "2026.8.18", { git: true });
      vi.mocked(updateGitCheckout).mockImplementationOnce(async ({ opts: options }) => {
        await requireValue(
          options.beforeGitMutation,
          "Git mutation admission",
        )(
          failure === "git metadata"
            ? { metadataUnreadable: "missing package metadata" }
            : { schemaVersions: { state: 3, agent: 11 } },
        );
        throw new Error("refused Git target must not mutate");
      });
    }
    if (failure === "package metadata") {
      vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({ version: null, error: "registry timeout" }),
      );
    }
    if (failure.endsWith("schema")) {
      vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
        packageTargetStatus({ schemaVersions: { state: 3, agent: 11 } }),
      );
      databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
        incompatible: [],
        indeterminate: [{ kind: "state", path: "/tmp/openclaw.sqlite", reason: "database busy" }],
      });
    }
    if (failure === "package runtime") {
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

  it("skips package schema preflight when target metadata is missing", async () => {
    await mockPackageInstallAtCaseDir("openclaw-schema-missing");
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(packageTargetStatus());

    await updateCommand({ yes: true, restart: false });

    expect(databasePreflightMocks.preflightOpenClawDatabaseSchemas).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()).toBeDefined();
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "settles a fresh update interrupted during target metadata admission (%s)",
    async (signal) => {
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
      vi.mocked(resolveNpmChannelTag).mockImplementation(async () => {
        entered();
        await pending;
        throw new Error("interrupted target metadata request");
      });
      const update = updateCommand({ yes: true, restart: false }).catch((error: unknown) => error);
      try {
        await Promise.race([
          requested,
          update.then(() => {
            throw new Error("Update ended before metadata admission");
          }),
        ]);
        const before = listUpdateRuns({ limit: 1 })[0]!;
        expect(before.status).toBe("running");
        const listeners = processOnSpy.mock.calls
          .filter(([event]) => event === signal)
          .map(([, listener]) => listener);
        expect(listeners.length).toBeGreaterThan(0);
        for (const listener of listeners) {
          listener();
        }
        // Inspect while metadata remains blocked: ordinary unwind cannot settle this row.
        expect(listUpdateRuns({ limit: 1 })[0]).toMatchObject({
          runId: before.runId,
          status: "failed",
          phase: "finished",
          reason: "interrupted",
          finishedAtMs: expect.any(Number),
        });
        await exitCalled.promise;
        expect(processExitSpy).toHaveBeenCalledWith(signal === "SIGINT" ? 130 : 143);
        expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe(packageBefore);
        expect(packageInstallCommandCall()).toBeUndefined();
        expect(serviceStop).not.toHaveBeenCalled();
      } finally {
        release();
        await update;
      }
    },
  );

  it("refuses a package update when exact target metadata lookup fails", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-schema-metadata-failure"));
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ version: null, nodeEngine: null, error: "registry timeout" }),
    );

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expectNoSideEffects(databasePreflightMocks.preflightOpenClawDatabaseSchemas, serviceStop);
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(getLogOutput()).toContain("The registry package metadata could not be read.");
    expect(getLogOutput()).toContain("retry openclaw update --tag <published-version>");
    expect(getLogOutput()).toContain(
      "Could not inspect exact package target openclaw@9999.0.0: registry timeout.",
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("continues a package update when target schemas are compatible", async () => {
    await mockPackageInstallAtCaseDir("openclaw-schema-compatible");
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ schemaVersions: { state: 3, agent: 11 } }),
    );

    await updateCommand({ yes: true, restart: false });

    expect(databasePreflightMocks.preflightOpenClawDatabaseSchemas).toHaveBeenCalled();
    for (const [input] of databasePreflightMocks.preflightOpenClawDatabaseSchemas.mock.calls) {
      expect(input).toMatchObject({ supportedVersions: { state: 3, agent: 11 } });
    }
    expect(packageInstallCommandCall()?.[0]).toContain("openclaw@9999.0.0");
  });

  it.each([true, false])(
    "uses inspected package runtime requirements when a later lookup disagrees (compatible=%s)",
    async (compatible) => {
      // This case specifies system-runtime guidance, independent of the host Node manager.
      vi.spyOn(versionManagerPath, "resolveNodeVersionManager").mockReturnValue("system");
      const root = await mockPackageInstallAtCaseDir("openclaw-runtime-target");
      const inspectedEngine = compatible ? ">=22.19.0" : ">=999.0.0";
      vi.mocked(fetchNpmPackageTargetStatus)
        .mockResolvedValueOnce(packageTargetStatus({ nodeEngine: inspectedEngine }))
        .mockResolvedValue(
          packageTargetStatus({ nodeEngine: compatible ? ">=999.0.0" : ">=22.19.0" }),
        );
      nodeVersionSatisfiesEngine.mockImplementation(
        (_version: string | null, engine: string | null) => engine !== ">=999.0.0",
      );

      if (compatible) {
        await updateCommand({ yes: true, restart: false });
      } else {
        await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(
          new ExitError(1),
        );
      }

      if (compatible) {
        expect(packageInstallCommandCall()?.[0]).toContain("openclaw@9999.0.0");
      } else {
        expect(packageInstallCommandCall()?.[0]).toBeUndefined();
        expect(listUpdateRuns({ limit: 1 })[0]?.reason).toBe("node-runtime-preflight");
        expect(defaultRuntime.log).toHaveBeenCalledWith(
          `openclaw@9999.0.0 requires Node >=999.0.0; selected runtime is Node ${process.versions.node}.\n${runtimeRecovery.expectedPlainRecovery("9999.0.0", "999.0.0", "absent", undefined, root)}`,
        );
      }
      expect(fetchNpmPackageTargetStatus).toHaveBeenCalledOnce();
    },
  );

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
      packageTargetStatus({ target: "1.0.0", version: "1.0.0" }),
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

  it("previews the resolved package owner without probing for another manager", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-dry-run-owner"));
    resolveGlobalManager.mockResolvedValueOnce("npm").mockResolvedValue("bun");

    await updateCommand({ dryRun: true, json: true });

    expect(lastWriteJsonCall()).toMatchObject({ mode: "npm" });
    expect(resolveGlobalManager).toHaveBeenCalledOnce();
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
  });

  it("does not clean handoffs before rejecting an unknown package owner", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-unknown-owner"));
    const refusal =
      "Update refused: package manager owner is unknown; no changes were made. Run this OpenClaw install through its active npm, pnpm, or Bun global shim, or reinstall it with that package manager, then retry.";
    resolveGlobalManager.mockRejectedValueOnce(new Error(refusal));

    await expect(updateCommand({ yes: true, restart: false })).rejects.toEqual(new ExitError(1));
    expect([getLogOutput(), getErrorOutput()].join("\n")).toContain(
      refusal.split(", then retry.")[0],
    );

    expect(cleanupStaleManagedServiceUpdateHandoffs).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
  });

  it("reports an incompatible package target during dry-run", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-schema-dry-run"));
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ schemaVersions: { state: 2, agent: 9 } }),
    );
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
      incompatible: [
        {
          kind: "state",
          path: "/tmp/openclaw/state/openclaw.sqlite",
          foundVersion: 3,
          supportedVersion: 2,
        },
      ],
      indeterminate: [],
    });

    await updateCommand({ dryRun: true });

    const logs = getLogOutput();
    expect(logs).toContain("Would refuse update: state database");
    expect(logs).toContain("https://docs.openclaw.ai/reference/database-schemas");
    expect(serviceStop).not.toHaveBeenCalled();
    expect(packageInstallCommandCall()?.[0]).toBeUndefined();
    expect(defaultRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("refuses an incompatible git target before stopping the service", async () => {
    mockOwnedGitService();
    serviceLoaded.mockResolvedValue(true);
    vi.mocked(updateGitCheckout).mockImplementationOnce(async ({ opts: options }) => {
      await requireValue(
        options.beforeGitMutation,
        "Git mutation admission",
      )({ schemaVersions: { state: 3, agent: 9 } });
      return makeOkUpdateResult({ mode: "git" });
    });
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
      incompatible: [
        {
          kind: "agent",
          path: "/tmp/openclaw/agents/main/agent/openclaw-agent.sqlite",
          foundVersion: 11,
          supportedVersion: 9,
        },
      ],
      indeterminate: [],
    });

    await expect(updateCommand({ yes: true })).rejects.toEqual(new ExitError(1));

    expectNoSideEffects(serviceStop, serviceRestart);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("reports indeterminate package databases during dry-run", async () => {
    mockPackageInstallStatus(createCaseDir("openclaw-schema-indeterminate-dry-run"));
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ schemaVersions: { state: 3, agent: 11 } }),
    );
    databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockReturnValue({
      incompatible: [],
      indeterminate: [
        { kind: "state", path: "/tmp/openclaw/state/openclaw.sqlite", reason: "database busy" },
      ],
    });

    await updateCommand({ dryRun: true });

    const logs = getLogOutput();
    expect(logs).toContain(
      "could not inspect state database /tmp/openclaw/state/openclaw.sqlite: database busy; retry once the gateway releases it",
    );
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
});
