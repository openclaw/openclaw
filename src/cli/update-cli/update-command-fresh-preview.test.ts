import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { assert, describe, expect, it, vi } from "vitest";
import { withTriageTerminal } from "../../commands/triage.test-support.js";
import * as stateCoordinator from "../../infra/state-database-coordinator.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import * as oneShotExit from "../one-shot-exit.js";
import { invokeUpdateCli } from "../update-cli-invocation.test-support.js";
import { registerUpdateCli } from "../update-cli.js";
import * as shared from "./shared.js";
import * as admissionEnvOwner from "./update-command-admission-env.js";
import * as databaseContext from "./update-command-database-context.js";
import * as execution from "./update-command-execution.js";
import * as executorOwner from "./update-command-executor.js";
import {
  captureFreshManagedServiceAdmission,
  freshManagedServiceRuntimeCases,
} from "./update-command-fresh-preview.test-support.js";
import {
  createSelectedTargetStateDatabase,
  installFreshUpdateFixture,
  targetMetadata,
  targetDoctorSuccess,
} from "./update-command-fresh.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import * as commandRun from "./update-command-run.js";
import * as servicePlan from "./update-command-service-plan.js";
import {
  deferUpdateCommandTerminalResult,
  publishUpdateCommandTerminalResult,
  resolveSettledUpdateCommandResult,
} from "./update-command-terminal.js";
import * as commandTriage from "./update-command-triage.js";
import { updateCommand } from "./update-command.js";

const promptConfirm = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@clack/prompts", async (original) => ({
  ...(await original<typeof import("@clack/prompts")>()),
  confirm: promptConfirm,
}));

const { fixture, dirs } = installFreshUpdateFixture();
const inheritedRunIds = [
  undefined,
  "f9ccab65-df92-4ba2-84b9-d15c9c37c9a0",
  "  1c5a25f3-f46a-408b-a87f-a0f0d1f80ee7  ",
  " \t ",
] as const;

function expectFreshStatePreserved() {
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
  expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
  expect(fs.readdirSync(fixture.root)).toEqual(["package.json"]);
}

function writeStoredChannel(channel: "stable" | "beta") {
  const configPath = process.env.OPENCLAW_CONFIG_PATH!;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ update: { channel } }));
  return configPath;
}

function failLegacyCoordinatorRelease(error: Error) {
  vi.mocked(shared.resolveTargetVersion).mockResolvedValue("2026.7.1");
  vi.mocked(updateCheck.resolveNpmChannelTag).mockResolvedValue({
    tag: "latest",
    version: "2026.7.1",
  });
  vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
    ...targetMetadata,
    target: "2026.7.1",
    version: "2026.7.1",
    schemaVersions: { state: 1, agent: 1 },
  });
  const acquire = stateCoordinator.acquireGatewayLifecycleCoordinator;
  const failedRelease = vi.fn(() => {
    throw error;
  });
  vi.spyOn(stateCoordinator, "acquireGatewayLifecycleCoordinator").mockImplementation((params) => {
    const lease = acquire(params);
    const release = lease.release;
    vi.spyOn(lease, "release").mockImplementation(() => {
      release();
      failedRelease();
    });
    return lease;
  });
  return failedRelease;
}

describe("update command admission with fresh state", () => {
  it("requires fresh downgrade confirmation without creating a run or exiting before release", async () => {
    await expect(
      updateCommand({ tag: "2026.9.2", json: true, restart: false }),
    ).rejects.toMatchObject({ code: 1 });
    expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped", reason: "downgrade-confirmation-required" }),
    );
    expect(createManagedHandoffLeaseStore().read(fixture.root).kind).toBe("absent");
    expectFreshStatePreserved();
  });

  it("cancels a fresh downgrade without a ledger and exits only after release", async () => {
    promptConfirm.mockResolvedValue(false);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    const exitAfterOutput = oneShotExit.exitCliAfterOutput;
    const leases: string[] = [];
    vi.spyOn(oneShotExit, "exitCliAfterOutput").mockImplementation((...args) => {
      leases.push(createManagedHandoffLeaseStore().read(fixture.root).kind);
      return exitAfterOutput(...args);
    });
    await withTriageTerminal(true, async () => {
      await expect(updateCommand({ tag: "2026.9.2", restart: false })).rejects.toMatchObject({
        code: 0,
      });
    });
    expect(leases).toEqual(["absent"]);
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    expectFreshStatePreserved();
  });

  it.each([false, true])(
    "reports an invalid fresh dev target after settlement (dry run=%s)",
    async (dryRun) => {
      const config = process.env.OPENCLAW_CONFIG_PATH!;
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, JSON.stringify({ update: { channel: "dev" } }));
      vi.spyOn(commandRun, "readDevUpdateTarget").mockImplementation(() => {
        throw new Error("fixture invalid dev target");
      });
      const triage = vi.spyOn(commandTriage, "prepareUpdateCommandFailureTriage");
      const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
        throw new ExitError(code);
      });
      await expect(
        invokeUpdateCli({ tag: "2026.9.2", yes: true, json: true, restart: false, dryRun }),
      ).rejects.toMatchObject({ code: 1 });
      expect(defaultRuntime.error).toHaveBeenCalledExactlyOnceWith("fixture invalid dev target");
      expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(dryRun ? 0 : 1);
      if (!dryRun) {
        expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
          expect.objectContaining({ status: "error", reason: "invalid-dev-target" }),
        );
      }
      expect(triage).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
      expectFreshStatePreserved();
    },
  );

  it.each([
    { source: "metadata", cleanup: "healthy" },
    { source: "metadata", cleanup: "release" },
    { source: "channel", cleanup: "healthy" },
    { source: "channel", cleanup: "close" },
    { source: "channel", cleanup: "release" },
    { source: "channel", cleanup: "coordinator" },
    { source: "channel", cleanup: "close-and-coordinator" },
  ])("publishes one settled fresh refusal ($source / $cleanup)", async ({ source, cleanup }) => {
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: true,
      value: {},
    });
    const denyRelease = () => {
      const db = new DatabaseSync(
        path.join(tempRoot.resolvePreferredOpenClawTmpDir(), "managed-update-handoffs.sqlite"),
      );
      try {
        db.exec(
          "CREATE TRIGGER deny_refusal_release BEFORE DELETE ON managed_update_handoffs BEGIN SELECT RAISE(FAIL, 'fixture refusal release denied'); END",
        );
      } finally {
        db.close();
      }
    };
    const observations: { closed: boolean; lease: string }[] = [];
    const staged = {
      root: fixture.root,
      run: vi.fn(),
      close: vi.fn().mockImplementation(async () => {
        if (cleanup === "release") {
          denyRelease();
        }
        if (cleanup.includes("close")) {
          throw new Error("fixture refused-stage cleanup failed");
        }
      }),
    };
    const legacyRelease = cleanup.includes("coordinator")
      ? failLegacyCoordinatorRelease(new Error("fixture legacy coordinator release failed"))
      : vi.fn();
    vi.mocked(defaultRuntime.writeJson).mockImplementation(() => {
      observations.push({
        closed: staged.close.mock.calls.length === 1,
        lease: createManagedHandoffLeaseStore().read(fixture.root).kind,
      });
    });
    if (source === "metadata") {
      vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockImplementationOnce(async () => {
        if (cleanup === "release") {
          denyRelease();
        }
        return {
          target: "2026.9.2",
          version: null,
          nodeEngine: null,
          error: "fixture registry unavailable",
        };
      });
    } else {
      writeStoredChannel("stable");
      vi.mocked(packageUpdate.stagePackageInstallUpdate).mockImplementationOnce(async () => {
        writeStoredChannel("beta");
        return staged;
      });
    }
    const failure = await stateCoordinator
      .withStateDatabaseCoordinatorRuntimeDirectory(tempRoot.resolvePreferredOpenClawTmpDir(), () =>
        updateCommand({ yes: true, json: true, restart: false }),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const reason =
      cleanup === "healthy"
        ? source === "metadata"
          ? "target-metadata-preflight"
          : "update-channel-changed"
        : "update-admission-cleanup-failed";
    expect(observations).toEqual([
      { closed: source === "channel", lease: cleanup === "release" ? "current" : "absent" },
    ]);
    expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", reason }),
    );
    expect(failure).toMatchObject({ code: 1 });
    if (cleanup !== "healthy") {
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        }),
      );
    }
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
    expect(staged.run).not.toHaveBeenCalled();
    expect(legacyRelease).toHaveBeenCalledTimes(cleanup.includes("coordinator") ? 1 : 0);
  });

  it("closes the stage when successful initialization is followed by legacy release failure", async () => {
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: true,
      value: {},
    });
    const staged = {
      root: fixture.root,
      run: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(staged);
    vi.spyOn(packageUpdate, "runPackageUpdateDoctor").mockImplementation(async () => {
      fs.mkdirSync(path.dirname(fixture.databasePath), { recursive: true });
      const db = new DatabaseSync(fixture.databasePath);
      try {
        db.exec("PRAGMA user_version=1; CREATE TABLE legacy_state(value TEXT)");
      } finally {
        db.close();
      }
      return targetDoctorSuccess;
    });
    const releaseError = new Error("fixture successful initialization release failed");
    const release = failLegacyCoordinatorRelease(releaseError);
    await expect(
      stateCoordinator.withStateDatabaseCoordinatorRuntimeDirectory(
        tempRoot.resolvePreferredOpenClawTmpDir(),
        () => updateCommand({ yes: true, json: true, restart: false }),
      ),
    ).rejects.toBe(releaseError);
    expect(staged.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(staged.run).not.toHaveBeenCalled();
    expect(createManagedHandoffLeaseStore().read(fixture.root).kind).toBe("absent");
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
  });

  it("settles fresh staging and executor before reporting changed admission selectors", async () => {
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: true,
      value: {},
    });
    const staged = {
      root: fixture.root,
      run: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(staged);
    vi.spyOn(packageUpdate, "runPackageUpdateDoctor").mockImplementation(async () => {
      createSelectedTargetStateDatabase(fixture.databasePath);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(path.dirname(fixture.root), "changed-profile"));
      return targetDoctorSuccess;
    });
    const observations: { boundary: string; closed: boolean; lease: string }[] = [];
    const observe = (boundary: string) => {
      observations.push({
        boundary,
        closed: staged.close.mock.calls.length === 1,
        lease: createManagedHandoffLeaseStore().read(fixture.root).kind,
      });
    };
    vi.mocked(defaultRuntime.writeJson).mockImplementation(() => observe("report"));
    const exitAfterOutput = oneShotExit.exitCliAfterOutput;
    vi.spyOn(oneShotExit, "exitCliAfterOutput").mockImplementation((...args) => {
      observe("exit");
      return exitAfterOutput(...args);
    });

    await expect(
      updateCommand({ tag: "2026.9.2", yes: true, json: true, restart: false }),
    ).rejects.toMatchObject({ code: 1 });

    expect(observations).toEqual([
      { boundary: "report", closed: true, lease: "absent" },
      { boundary: "exit", closed: true, lease: "absent" },
    ]);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", reason: "managed-service-preflight" }),
    );
    expect(staged.run).not.toHaveBeenCalled();
    expect(staged.close).toHaveBeenCalledOnce();
  });

  it.each([
    ...inheritedRunIds.map((inheritedRunId) => ({ fault: "healthy", inheritedRunId })),
    { fault: "release-failure", inheritedRunId: undefined },
    { fault: "stage-cleanup-failure", inheritedRunId: undefined },
  ])(
    "settles fresh initialization before terminal publication ($fault, inherited run: $inheritedRunId)",
    async ({ fault, inheritedRunId }) => {
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", inheritedRunId);
      let executorRunId: string | undefined;
      const withExecutor = executorOwner.withUpdateCommandExecutor;
      vi.spyOn(executorOwner, "withUpdateCommandExecutor").mockImplementation(
        (runId, operation) => {
          executorRunId = runId;
          return withExecutor(runId, operation);
        },
      );
      vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
        ok: true,
        value: {},
      });
      vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
        throw new Error(`fixture CLI exit ${code}`);
      });
      let admittedRun: shared.UpdateCommandOptions["run"];
      let triagePrepared = false;
      const prepareTriage = commandTriage.prepareUpdateCommandFailureTriage;
      vi.spyOn(commandTriage, "prepareUpdateCommandFailureTriage").mockImplementation(
        async (...args) => {
          const handler = await prepareTriage(...args);
          triagePrepared = true;
          return handler;
        },
      );
      let leaseAtPublication: string | undefined;
      vi.mocked(defaultRuntime.writeJson).mockImplementation(() => {
        leaseAtPublication = createManagedHandoffLeaseStore().read(fixture.root).kind;
      });
      let outputAtCleanup = -1;
      let historyAtCleanup: string | undefined;
      const staged = {
        root: fixture.root,
        run: vi.fn(),
        close: vi.fn().mockImplementation(async () => {
          outputAtCleanup = vi.mocked(defaultRuntime.writeJson).mock.calls.length;
          historyAtCleanup =
            admittedRun && getUpdateRun(admittedRun.runId, { env: admittedRun.env })?.status;
          if (fault === "stage-cleanup-failure") {
            throw new Error("fixture stage cleanup failed");
          }
          if (fault === "release-failure") {
            const filename = path.join(
              tempRoot.resolvePreferredOpenClawTmpDir(),
              "managed-update-handoffs.sqlite",
            );
            const db = new DatabaseSync(filename);
            try {
              db.exec(
                "CREATE TRIGGER deny_terminal_release BEFORE DELETE ON managed_update_handoffs BEGIN SELECT RAISE(FAIL, 'fixture final lease delete denied'); END",
              );
            } finally {
              db.close();
            }
          }
        }),
      };
      vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(staged);
      vi.spyOn(packageUpdate, "runPackageUpdateDoctor").mockImplementation(async () => {
        expect(fs.existsSync(fixture.databasePath)).toBe(false);
        createSelectedTargetStateDatabase(fixture.databasePath);
        return targetDoctorSuccess;
      });
      vi.spyOn(execution, "executeMutableUpdate").mockImplementation(async (params) => {
        // The installation work is complete; keep its real terminal publisher,
        // ledger, executor, and outer staged-package cleanup to prove ordering.
        admittedRun = params.opts.run;
        expect(triagePrepared).toBe(true);
        const result = {
          status: "ok" as const,
          mode: "npm" as const,
          root: fixture.root,
          steps: [],
          durationMs: 1,
        };
        const publish = async (failure?: unknown) => {
          const settled = await resolveSettledUpdateCommandResult(
            { opts: params.opts, root: fixture.root },
            result,
            failure,
          );
          return publishUpdateCommandTerminalResult({ opts: params.opts }, settled.result, {
            rolledBack: false,
          });
        };
        if (!deferUpdateCommandTerminalResult(params.opts.run, publish)) {
          await publish();
        }
        return null;
      });

      const outcome = await updateCommand({
        tag: "2026.9.2",
        yes: true,
        json: true,
        restart: false,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(packageUpdate.runPackageUpdateDoctor).toHaveBeenCalledOnce();
      assert(admittedRun);
      expect(admittedRun.runId).toBe(executorRunId);
      expect(admittedRun.runId.trim()).not.toBe("");
      expect(admittedRun.runId).toBe(inheritedRunId?.trim() || executorRunId);
      expect(outputAtCleanup).toBe(0);
      expect(historyAtCleanup).toBe("running");
      expect(staged.close).toHaveBeenCalledOnce();
      expect(leaseAtPublication).toBe(fault === "release-failure" ? "current" : "absent");
      expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ status: fault === "healthy" ? "ok" : "error" }),
      );
      assert(admittedRun);
      expect(getUpdateRun(admittedRun.runId, { env: admittedRun.env })?.status).toBe(
        fault === "healthy" ? "succeeded" : "failed",
      );
      expect(outcome === undefined).toBe(fault === "healthy");
    },
  );

  it("registered update CLI reports the installed version for fresh saved-dev previews", async () => {
    fs.mkdirSync(path.dirname(process.env.OPENCLAW_CONFIG_PATH!), { recursive: true });
    fs.writeFileSync(
      process.env.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({ update: { channel: "dev" } }),
    );
    vi.stubEnv("OPENCLAW_GIT_DIR", path.join(fixture.root, "missing-checkout"));
    const program = new Command();
    registerUpdateCli(program);

    await program.parseAsync(["update", "--dry-run", "--json", "--no-restart"], { from: "user" });

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        currentVersion: "2026.9.3",
        targetVersion: null,
        targetVersionReason: expect.stringContaining("Git"),
        switchToGit: true,
      }),
    );
    expect(vi.mocked(defaultRuntime.writeJson).mock.calls[0]?.[0]).toHaveProperty("run", undefined);
    expectFreshStatePreserved();
  });

  it.each(inheritedRunIds)(
    "previews an older stable without runtime state (inherited run: %s)",
    async (inheritedRunId) => {
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", inheritedRunId);
      await updateCommand({ tag: "2026.9.2", dryRun: true, json: true, restart: false });

      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          dryRun: true,
          currentVersion: "2026.9.3",
          targetVersion: "2026.9.2",
          downgradeRisk: true,
        }),
      );
      expectFreshStatePreserved();
    },
  );

  it.each([{ channel: "stable" }, { tag: "latest" }])(
    "refuses unresolved registry metadata for %j before creating runtime state",
    async (target) => {
      vi.mocked(shared.resolveTargetVersion).mockResolvedValue(null);
      vi.mocked(updateCheck.resolveNpmChannelTag).mockResolvedValue({
        tag: "latest",
        version: null,
      });

      await expect(
        updateCommand({ ...target, yes: true, json: true, restart: false }),
      ).rejects.toMatchObject({ code: 1 });

      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          reason: "target-metadata-preflight",
          mode: "npm",
          steps: [
            expect.objectContaining({
              failureFacts: [expect.objectContaining({ code: "target-registry-dist-tag" })],
            }),
          ],
        }),
      );
      expectFreshStatePreserved();
    },
  );

  it.each(inheritedRunIds)(
    "reports exact package metadata failure without runtime state (inherited run: %s)",
    async (inheritedRunId) => {
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", inheritedRunId);
      vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
        target: "2026.9.2",
        version: null,
        nodeEngine: null,
        error: "registry unavailable",
      });

      await expect(
        updateCommand({ tag: "2026.9.2", yes: true, json: true, restart: false }),
      ).rejects.toMatchObject({ code: 1 });

      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error", reason: "target-metadata-preflight" }),
      );
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("registry unavailable"),
      );
      expectFreshStatePreserved();
    },
  );

  it.each(freshManagedServiceRuntimeCases)(
    "limits fresh-state Node recovery ($name)",
    async (testCase) => {
      const { owned, writable, restart, discovered, expectedFallback, expectedRecovery } = testCase;
      fixture.managedServiceNodeRunner = discovered ? "/service/node" : undefined;
      vi.spyOn(shared, "resolveNodeRunner").mockReturnValue("/current/node");
      vi.mocked(databaseContext.inspectUpdateDatabaseContexts).mockImplementation(() =>
        captureFreshManagedServiceAdmission({ root: fixture.root, owned, writable, restart }),
      );
      const runtimePreflight = vi
        .spyOn(servicePlan, "resolvePackageRuntimePreflight")
        .mockResolvedValue({ ok: false, error: "fixture-stop" });

      await expect(
        updateCommand({ tag: "2026.9.2", yes: true, json: true, restart }),
      ).rejects.toMatchObject({ code: 1 });

      expect(runtimePreflight).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          nodeRunner: discovered ? "/service/node" : undefined,
          fallbackNodeRunner: expectedFallback,
          runtimeRecovery: expectedRecovery ? expect.any(Object) : undefined,
        }),
      );
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error", reason: "node-runtime-preflight" }),
      );
      expectFreshStatePreserved();
    },
  );

  it("selects the fresh managed profile's stored channel instead of the shell profile's channel", async () => {
    const shellConfigPath = process.env.OPENCLAW_CONFIG_PATH!;
    fs.mkdirSync(path.dirname(shellConfigPath), { recursive: true });
    fs.writeFileSync(shellConfigPath, JSON.stringify({ update: { channel: "stable" } }));
    const serviceStateDir = dirs.make("openclaw-update-managed-profile-");
    const serviceConfigPath = path.join(serviceStateDir, "openclaw.json");
    fs.writeFileSync(serviceConfigPath, JSON.stringify({ update: { channel: "beta" } }));
    const serviceEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: serviceStateDir,
      OPENCLAW_CONFIG_PATH: serviceConfigPath,
    };
    vi.spyOn(admissionEnvOwner, "resolveUpdateCommandAdmissionEnv").mockResolvedValue(serviceEnv);
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: false,
      error: "fixture-stop",
    });
    vi.mocked(updateCheck.resolveNpmChannelTag).mockResolvedValue({
      tag: "beta",
      version: "2026.9.2",
    });

    await expect(updateCommand({ yes: true, json: true, restart: false })).rejects.toMatchObject({
      code: 1,
    });

    expect(
      vi.mocked(updateCheck.resolveNpmChannelTag).mock.calls.map(([params]) => params.channel),
    ).toEqual(["beta"]);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath(serviceEnv))).toBe(false);
    expect(process.env.OPENCLAW_CONFIG_PATH).toBe(shellConfigPath);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", reason: "node-runtime-preflight" }),
    );
    expectFreshStatePreserved();
  });

  it.each([
    { channel: undefined, reason: "update-channel-changed" },
    { channel: "stable" as const, reason: "node-runtime-preflight" },
  ])(
    "fences a changed stored channel after target lookup with explicit channel=$channel",
    async ({ channel, reason }) => {
      const configPath = writeStoredChannel("stable");
      vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockImplementationOnce(async () => {
        writeStoredChannel("beta");
        return targetMetadata;
      });
      const runtime = vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
        ok: false,
        error: "fixture-stop",
      });

      await expect(
        updateCommand({ channel, yes: true, json: true, restart: false }),
      ).rejects.toMatchObject({ code: 1 });

      expect(
        vi.mocked(updateCheck.resolveNpmChannelTag).mock.calls.map(([params]) => params.channel),
      ).toEqual(["stable"]);
      expect(runtime).toHaveBeenCalledTimes(channel ? 1 : 0);
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error", reason }),
      );
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
        update: { channel: "beta" },
      });
      expectFreshStatePreserved();
    },
  );

  it("refuses a stored-channel change during staging before target Doctor or activation", async () => {
    const configPath = writeStoredChannel("stable");
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: true,
      value: {},
    });
    const staged = {
      root: fixture.root,
      run: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockImplementationOnce(async () => {
      writeStoredChannel("beta");
      return staged;
    });
    const doctor = vi
      .spyOn(packageUpdate, "runPackageUpdateDoctor")
      .mockRejectedValue(new Error("Unexpected target Doctor"));

    await expect(updateCommand({ yes: true, json: true, restart: false })).rejects.toMatchObject({
      code: 1,
    });

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", reason: "update-channel-changed" }),
    );
    expect(doctor).not.toHaveBeenCalled();
    expect(staged.run).not.toHaveBeenCalled();
    expect(staged.close).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
      update: { channel: "beta" },
    });
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
  });

  it("accepts target Doctor config changes that preserve the selected stored channel", async () => {
    const configPath = writeStoredChannel("stable");
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: true,
      value: {},
    });
    const staged = {
      root: fixture.root,
      run: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(staged);
    const migrated = {
      update: { channel: "stable" },
      gateway: { mode: "local" },
      meta: { lastTouchedVersion: "2026.9.2" },
    };
    const afterDoctor = new Error("Fixture stopped after target Doctor revalidation");
    vi.spyOn(packageUpdate, "runPackageUpdateDoctor").mockImplementation(async () => {
      fs.writeFileSync(configPath, JSON.stringify(migrated));
      createSelectedTargetStateDatabase(fixture.databasePath);
      return targetDoctorSuccess;
    });
    const admit = vi.spyOn(commandRun, "admitUpdateCommandRun").mockRejectedValue(afterDoctor);

    await expect(updateCommand({ yes: true, json: true, restart: false })).rejects.toBe(
      afterDoctor,
    );

    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual(migrated);
    expect(admit).toHaveBeenCalledOnce();
    expect(staged.close).toHaveBeenCalledOnce();
    expect(staged.run).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.databasePath)).toBe(true);
  });

  it("keeps fresh staging releasable for a supervised handoff before package activation", async () => {
    let fence: UpdateRecoveryFence | undefined;
    const withExecutor = executorOwner.withUpdateCommandExecutor;
    vi.spyOn(executorOwner, "withUpdateCommandExecutor").mockImplementation((runId, operation) =>
      withExecutor(runId, async (executor) => {
        const enter = executor.enter.bind(executor);
        vi.spyOn(executor, "enter").mockImplementation(async (...args) => {
          fence = await enter(...args);
          return fence;
        });
        return await operation(executor);
      }),
    );
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: true,
      value: {},
    });
    const staged = {
      root: fixture.root,
      run: vi.fn().mockRejectedValue(new Error("Unexpected package activation")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(staged);
    const handoffStop = new Error("Fixture stopped after successful preflight handoff release");
    vi.spyOn(packageUpdate, "runPackageUpdateDoctor").mockImplementation(async () => {
      assert(fence);
      executorOwner.releaseUpdateCommandPreflightForHandoff(fence);
      throw handoffStop;
    });

    await expect(
      updateCommand({ tag: "2026.9.2", yes: true, json: true, restart: true }),
    ).rejects.toBe(handoffStop);

    expect(staged.close).toHaveBeenCalledOnce();
    expect(staged.run).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
    expect(fs.readdirSync(fixture.root)).toEqual(["package.json"]);
  });
});
