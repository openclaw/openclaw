import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import * as check from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as cli from "./update-cli-modules.test-support.js";
import {
  newerAgentSchemaFixture,
  packageTargetStatus,
} from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

const { defaultRuntime: runtime, updateCommand: runUpdate } = cli;
const { packageInstallCommandCall: packageInstall } = check;

describe("update-cli", () => {
  const {
    createCaseDir,
    initializeExistingUpdateProfile,
    mockFileBackedPathExists,
    mockNpmGlobalRoot,
    mockOwnedGitService,
    mockPackageInstallAtCaseDir,
    primeNpmChannelTag,
    primeServiceCommand,
    profileStateDir,
    setupInstalledPackageRoot,
    runControlPlaneUpdate,
  } = createUpdateCliFixture();

  it("previews a service-only incompatible package target before any mutable preparation", async () => {
    const fixture = createCaseDir("schema-service-only-package-preview");
    const {
      pkgRoot: root,
      nodeModules,
      entryPath,
    } = await setupInstalledPackageRoot(fixture, "1.0.0");
    mockFileBackedPathExists();
    mockNpmGlobalRoot(nodeModules);
    const managedState = profileStateDir("work");
    initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: managedState });
    const callerState = profileStateDir("personal");
    initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: callerState });
    mockOwnedGitService(root);
    primeServiceCommand([process.execPath, entryPath, "gateway", "run"], {
      OPENCLAW_PROFILE: "work",
      OPENCLAW_STATE_DIR: managedState,
      OPENCLAW_CONFIG_PATH: path.join(managedState, "openclaw.json"),
    });
    mocks.serviceLoaded.mockResolvedValue(true);
    vi.mocked(cli.fetchNpmPackageTargetStatus).mockResolvedValue(
      packageTargetStatus({ schemaVersions: { state: 3, agent: 11 } }),
    );
    const inspectedStates: Array<string | undefined> = [];
    mocks.databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(({ env }) => {
      inspectedStates.push(env.OPENCLAW_STATE_DIR);
      return {
        incompatible:
          env.OPENCLAW_STATE_DIR === managedState
            ? [
                newerAgentSchemaFixture(
                  path.join(managedState, "agents", "worker", "agent", "openclaw-agent.sqlite"),
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
      },
      async () => {
        await runUpdate({ dryRun: true });
        expect(check.getLogOutput()).toContain("Would refuse update: agent database");
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
  });

  it("previews explicit artifacts without claiming staged plugin admission", async () => {
    await mockPackageInstallAtCaseDir("openclaw-local-preview");
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

  it("reports unavailable plugins in a preview without refusing the core update", async () => {
    const detail =
      'Plugin "example" update availability could not be confirmed before core installation.';
    const sentinel = await runControlPlaneUpdate({
      meta: {
        sessionKey: "agent:main:webchat:dm:user-123",
        handoffId: "plugin-admission",
      },
      options: { dryRun: true, yes: true, json: true },
      beforeUpdate: async () => {
        await mockPackageInstallAtCaseDir();
        mocks.pluginAvailabilityPreflight.mockResolvedValue([
          { pluginId: "example", reason: detail, message: detail, guidance: [] },
        ]);
      },
    });

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
  });
});
