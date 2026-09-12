import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, describe, expect, it, vi } from "vitest";
import { withTriageTerminal } from "../../commands/triage.test-support.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { removePreparedWorkerOwnershipColumns } from "../../state/openclaw-state-schema-v17.test-support.js";
import * as oneShotExit from "../one-shot-exit.js";
import * as shared from "./shared.js";
import * as execution from "./update-command-execution.js";
import * as executorOwner from "./update-command-executor.js";
import { installFreshUpdateFixture, targetMetadata } from "./update-command-fresh.test-support.js";
import * as initialization from "./update-command-initialization.js";
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

function createSelectedTargetStateDatabase() {
  openOpenClawStateDatabase();
  closeOpenClawStateDatabaseForTest();
  const db = new DatabaseSync(fixture.databasePath);
  try {
    removePreparedWorkerOwnershipColumns(db);
    db.exec(
      "PRAGMA user_version=16; UPDATE schema_meta SET schema_version=16, app_version='2026.9.2'",
    );
  } finally {
    db.close();
  }
}

function writeStoredChannel(channel: "stable" | "beta") {
  const configPath = process.env.OPENCLAW_CONFIG_PATH!;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ update: { channel } }));
  return configPath;
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

  it("reports an invalid fresh dev target as a settled admission refusal", async () => {
    const config = process.env.OPENCLAW_CONFIG_PATH!;
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ update: { channel: "dev" } }));
    vi.spyOn(commandRun, "readDevUpdateTarget").mockImplementation(() => {
      throw new Error("fixture invalid dev target");
    });
    await expect(
      updateCommand({ tag: "2026.9.2", yes: true, json: true, restart: false }),
    ).rejects.toMatchObject({ code: 1 });
    expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", reason: "invalid-dev-target" }),
    );
    expectFreshStatePreserved();
  });

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
    const legacyRelease = vi.fn(() => {
      throw new Error("fixture legacy coordinator release failed");
    });
    if (cleanup.includes("coordinator")) {
      vi.spyOn(initialization, "acquireLegacyUpdateInitializationFence").mockReturnValue({
        path: path.join(fixture.root, "fixture-coordinator"),
        closed: false,
        release: legacyRelease,
      });
    }
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
    const failure = await updateCommand({ yes: true, json: true, restart: false }).then(
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
    vi.spyOn(initialization, "initializeUpdateStateFromTarget").mockImplementation(async () => {
      createSelectedTargetStateDatabase();
    });
    const releaseError = new Error("fixture successful initialization release failed");
    const release = vi.fn(() => {
      throw releaseError;
    });
    vi.spyOn(initialization, "acquireLegacyUpdateInitializationFence").mockReturnValue({
      path: path.join(fixture.root, "fixture-coordinator"),
      closed: false,
      release,
    });
    await expect(updateCommand({ yes: true, json: true, restart: false })).rejects.toBe(
      releaseError,
    );
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
    vi.spyOn(initialization, "initializeUpdateStateFromTarget").mockImplementation(async () => {
      createSelectedTargetStateDatabase();
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(path.dirname(fixture.root), "changed-profile"));
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
      vi.spyOn(initialization, "initializeUpdateStateFromTarget").mockImplementation(async () => {
        expect(fs.existsSync(fixture.databasePath)).toBe(false);
        createSelectedTargetStateDatabase();
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

      expect(initialization.initializeUpdateStateFromTarget).toHaveBeenCalledOnce();
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
        expect.objectContaining({ status: "error", reason: "target-metadata-preflight" }),
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

  it.each([
    { owned: true, restart: true, expectedFallback: "/current/node" },
    { owned: false, restart: true, expectedFallback: undefined },
    { owned: true, restart: false, expectedFallback: undefined },
  ])(
    "limits fresh-state Node fallback to the service it will refresh (owned=$owned, restart=$restart)",
    async ({ owned, restart, expectedFallback }) => {
      fixture.managedServiceNodeRunner = "/service/node";
      vi.spyOn(shared, "resolveNodeRunner").mockReturnValue("/current/node");
      vi.spyOn(servicePlan, "gatewayServiceCommandUsesRoot").mockResolvedValue(owned);
      const runtimePreflight = vi
        .spyOn(servicePlan, "resolvePackageRuntimePreflight")
        .mockResolvedValue({ ok: false, error: "fixture-stop" });

      await expect(
        updateCommand({ tag: "2026.9.2", yes: true, json: true, restart }),
      ).rejects.toMatchObject({ code: 1 });

      expect(
        runtimePreflight.mock.calls.map(([params]) => ({
          nodeRunner: params.nodeRunner,
          fallbackNodeRunner: params.fallbackNodeRunner,
        })),
      ).toEqual([
        {
          nodeRunner: "/service/node",
          fallbackNodeRunner: expectedFallback,
        },
      ]);
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
    vi.spyOn(commandRun, "resolveUpdateCommandAdmissionEnv").mockResolvedValue(serviceEnv);
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
    vi.spyOn(initialization, "initializeUpdateStateFromTarget").mockImplementation(
      async (params) => {
        await params.checkSchemas();
        fs.writeFileSync(configPath, JSON.stringify(migrated));
        await params.checkSchemas();
        throw afterDoctor;
      },
    );

    await expect(updateCommand({ yes: true, json: true, restart: false })).rejects.toBe(
      afterDoctor,
    );

    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual(migrated);
    expect(staged.close).toHaveBeenCalledOnce();
    expect(staged.run).not.toHaveBeenCalled();
    expect(fs.existsSync(fixture.databasePath)).toBe(false);
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
    vi.spyOn(initialization, "initializeUpdateStateFromTarget").mockImplementation(async () => {
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

it("fresh local artifact reaches compatible target staging without creating parent state", async () => {
  const source = dirs.make("openclaw-synthetic-artifact-");
  const packageDir = path.join(source, "package");
  fs.mkdirSync(packageDir);
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2026.9.2",
      engines: { node: ">=22" },
      openclaw: { schemaVersions: { state: 16, agent: 19 } },
    }),
  );
  const artifact = path.join(source, "candidate.tgz");
  execFileSync("tar", ["-czf", artifact, "-C", source, "package"]);
  vi.mocked(shared.resolveTargetVersion).mockResolvedValue(null);
  vi.mocked(packageUpdate.stagePackageInstallUpdate).mockRejectedValue(
    new Error("artifact-staged"),
  );
  const outcome = await updateCommand({
    tag: artifact,
    yes: true,
    json: true,
    restart: false,
  }).then(
    () => "completed",
    (error: unknown) => (error instanceof Error ? error.message : "unknown"),
  );
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
  expect(outcome).toBe("artifact-staged");
});

it.each([16, undefined] as const)(
  "inspects artifact schema %s before canonical initialization and history",
  async (schema) => {
    const candidate = dirs.make("openclaw-artifact-candidate-");
    fs.writeFileSync(
      path.join(candidate, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.2",
        engines: { node: ">=22" },
        ...(schema === undefined
          ? {}
          : { openclaw: { schemaVersions: { state: schema, agent: 19 } } }),
      }),
    );
    vi.mocked(shared.resolveTargetVersion).mockResolvedValue(null);
    const staged = { root: candidate, run: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    let privateState: string | undefined;
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockImplementation(async (params) => {
      privateState = params.installEnv?.OPENCLAW_STATE_DIR;
      expect(privateState).not.toBe(process.env.OPENCLAW_STATE_DIR);
      expect(params.installEnv?.HOME).toBe(process.env.HOME);
      expect(params.managedServiceEnv?.OPENCLAW_STATE_DIR).toBe(process.env.OPENCLAW_STATE_DIR);
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
      return staged;
    });
    const runtime = vi
      .spyOn(servicePlan, "resolvePackageRuntimePreflight")
      .mockResolvedValue({ ok: true, value: {} });
    const doctor = vi
      .spyOn(initialization, "initializeUpdateStateFromTarget")
      .mockImplementation(async (params) => {
        expect(params.root).toBe(candidate);
        expect(params.env.OPENCLAW_STATE_DIR).toBe(process.env.OPENCLAW_STATE_DIR);
        expect(fs.existsSync(fixture.databasePath)).toBe(false);
        if (schema === 16) {
          createSelectedTargetStateDatabase();
        } else {
          openOpenClawStateDatabase();
          closeOpenClawStateDatabaseForTest();
        }
      });
    const admission = vi
      .spyOn(commandRun, "admitUpdateCommandRun")
      .mockRejectedValue(new Error("artifact-admitted"));
    const outcome = await updateCommand({
      tag: "file:/fixture/candidate.tgz",
      yes: true,
      json: true,
      restart: false,
    }).then(
      () => "completed",
      (error: unknown) => (error instanceof Error ? error.message : "unknown"),
    );
    expect(staged.close).toHaveBeenCalledOnce();
    expect(privateState).toBeDefined();
    expect(fs.existsSync(path.dirname(privateState!))).toBe(false);
    if (schema === undefined) {
      expect(doctor).not.toHaveBeenCalled();
      expect(admission).not.toHaveBeenCalled();
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "target-metadata-preflight" }),
      );
    } else {
      expect(outcome).toBe("artifact-admitted");
      expect(doctor).toHaveBeenCalledOnce();
      expect(runtime).toHaveBeenCalledWith(
        expect.objectContaining({ target: { version: "2026.9.2", nodeEngine: ">=22" } }),
      );
      expect(admission).toHaveBeenCalledOnce();
      const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
      try {
        expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: schema });
      } finally {
        db.close();
      }
    }
  },
);

it.each(["node", "concurrent-state"] as const)(
  "refuses artifact %s incompatibility before canonical Doctor or history",
  async (fault) => {
    const candidate = dirs.make("openclaw-artifact-refusal-");
    fs.writeFileSync(
      path.join(candidate, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.2",
        engines: { node: ">=22" },
        openclaw: { schemaVersions: { state: 16, agent: 19 } },
      }),
    );
    vi.mocked(shared.resolveTargetVersion).mockResolvedValue(null);
    let previous: Buffer | undefined;
    const stage = { root: candidate, run: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockImplementation(async () => {
      if (fault === "concurrent-state") {
        openOpenClawStateDatabase();
        closeOpenClawStateDatabaseForTest();
        previous = fs.readFileSync(fixture.databasePath);
      }
      return stage;
    });
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: false,
      error: "selected artifact requires a newer Node",
    });
    const doctor = vi.spyOn(initialization, "initializeUpdateStateFromTarget");
    const admission = vi.spyOn(commandRun, "admitUpdateCommandRun");
    await updateCommand({
      tag: "file:/fixture/candidate.tgz",
      yes: true,
      json: true,
      restart: false,
    }).catch(() => undefined);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: fault === "node" ? "node-runtime-preflight" : "database-schema-preflight",
      }),
    );
    expect(doctor).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
    expect(stage.run).not.toHaveBeenCalled();
    expect(stage.close).toHaveBeenCalledOnce();
    if (previous) {
      expect(fs.readFileSync(fixture.databasePath)).toEqual(previous);
    } else {
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
    }
  },
);

it("requires confirmation for an inspected older artifact without a TTY", async () => {
  const candidate = dirs.make("artifact-downgrade-");
  fs.writeFileSync(
    path.join(candidate, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2026.9.2",
      openclaw: { schemaVersions: { state: 16, agent: 19 } },
    }),
  );
  vi.mocked(shared.resolveTargetVersion).mockResolvedValue(null);
  const stage = { root: candidate, run: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(stage);
  vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
    ok: true,
    value: {},
  });
  const doctor = vi
    .spyOn(initialization, "initializeUpdateStateFromTarget")
    .mockRejectedValue(new Error("confirmation was bypassed"));
  const admission = vi.spyOn(commandRun, "admitUpdateCommandRun");
  await updateCommand({ tag: "file:/fixture/older.tgz", json: true, restart: false }).catch(
    () => undefined,
  );
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({ status: "skipped", reason: "downgrade-confirmation-required" }),
  );
  expect(doctor).not.toHaveBeenCalled();
  expect(admission).not.toHaveBeenCalled();
  expect(stage.close).toHaveBeenCalledOnce();
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
});

it.each([17, 18])(
  "admits compatible parent history before artifact schema %s migration",
  async (schema) => {
    const candidate = dirs.make("artifact-forward-");
    fs.writeFileSync(
      path.join(candidate, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.4",
        engines: { node: ">=22" },
        openclaw: { schemaVersions: { state: schema, agent: 19 } },
      }),
    );
    vi.mocked(shared.resolveTargetVersion).mockResolvedValue(null);
    const stage = { root: candidate, run: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(stage);
    vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: true,
      value: {},
    });
    const doctor = vi
      .spyOn(initialization, "initializeUpdateStateFromTarget")
      .mockImplementation(async () => {
        openOpenClawStateDatabase();
        closeOpenClawStateDatabaseForTest();
        const db = new DatabaseSync(fixture.databasePath);
        try {
          db.exec(`PRAGMA user_version=${schema}; UPDATE schema_meta SET schema_version=${schema}`);
        } finally {
          db.close();
        }
      });
    const execute = vi
      .spyOn(execution, "executeMutableUpdate")
      .mockImplementation(async (params) => {
        const run = params.opts.run;
        assert(run);
        const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
        try {
          expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 17 });
        } finally {
          db.close();
        }
        expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
        finishUpdateRun(
          run.runId,
          { status: "skipped", reason: "fixture-before-forward-migration" },
          { env: run.env },
        );
        return null;
      });
    const outcome = await updateCommand({
      tag: "file:/fixture/forward.tgz",
      yes: true,
      json: true,
      restart: false,
    }).then(
      () => "admitted",
      () => "rejected",
    );
    expect(outcome).toBe("admitted");
    expect(doctor.mock.calls.length).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
    expect(stage.close).toHaveBeenCalledOnce();
  },
);
