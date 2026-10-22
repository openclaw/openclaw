import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Command } from "commander";
import { assert, describe, expect, it, vi } from "vitest";
import { doctorCommand } from "../../commands/doctor.js";
import { withTriageTerminal } from "../../commands/triage.test-support.js";
import * as doctorContributions from "../../flows/doctor-health-contributions.js";
import * as packageRoot from "../../infra/openclaw-root.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import * as devUpdateTarget from "../../infra/update-dev-target.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import * as recoveryBaseline from "../../infra/update-recovery-baseline-capture.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import * as history from "../../infra/update-run-reader.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { VERSION } from "../../version.js";
import * as oneShotExit from "../one-shot-exit.js";
import { invokeUpdateCli } from "../update-cli-invocation.test-support.js";
import { registerUpdateCli } from "../update-cli.js";
import * as shared from "./shared.js";
import * as execution from "./update-command-execution.js";
import * as executorOwner from "./update-command-executor.js";
import {
  allowPackageRuntime,
  createSelectedTargetStateDatabase,
  createStage,
  registerOriginalCaptureTests,
} from "./update-command-fresh-preview.test-support.js";
import {
  expectFreshStatePreserved,
  expectNoFreshCalls,
  denyFreshLeaseRelease,
  installFreshUpdateFixture,
  targetMetadata,
  writeFreshJson,
} from "./update-command-fresh.test-support.js";
import * as initialization from "./update-command-initialization.js";
import { updateResult } from "./update-command-maintenance-fixtures.test-support.js";
import * as packageUpdate from "./update-command-package.js";
import * as commandRun from "./update-command-run.js";
import * as runtimePlan from "./update-command-runtime-preflight.js";
import {
  deferUpdateCommandTerminalResult,
  resolveSettledUpdateCommandResult,
} from "./update-command-terminal.js";
import { publishUpdateCommandTerminalResultForTest as publishUpdateCommandTerminalResult } from "./update-command-terminal.test-support.js";
import * as commandTriage from "./update-command-triage.js";
import { updateCommand } from "./update-command.js";

const promptConfirm = vi.hoisted(() => vi.fn(async () => false));
vi.mock("@clack/prompts", async (original) => ({
  ...(await original<typeof import("@clack/prompts")>()),
  confirm: promptConfirm,
}));

const { fixture, dirs } = installFreshUpdateFixture();
const inheritedRunIds = ["  1c5a25f3-f46a-408b-a87f-a0f0d1f80ee7  ", " \t "] as const;

function writeConfig(config: unknown) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH!;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  return writeFreshJson(configPath, config);
}

function writeStoredChannel(channel: "stable" | "beta" | "dev") {
  return writeConfig({ update: { channel } });
}

function runUpdate(opts: shared.UpdateCommandOptions = {}) {
  return updateCommand({ yes: true, json: true, restart: false, ...opts });
}

function expectJson(result: unknown) {
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith(expect.objectContaining(result));
}

function expectMetadataFailure(
  fact: { code: string; message?: unknown },
  output: Record<string, unknown> = {},
) {
  const failure = expect.objectContaining({
    name: "target-metadata-preflight",
    exitCode: 1,
    failureFacts: [expect.objectContaining(fact)],
  });
  expectJson({
    reason: "target-metadata-preflight",
    mode: "npm",
    failedStep: failure,
    steps: expect.arrayContaining([failure]),
    ...output,
  });
}

function createArtifact(version: string, schema: number | undefined, node?: string) {
  const candidate = dirs.make("openclaw-artifact-");
  writeFreshJson(path.join(candidate, "package.json"), {
    name: "openclaw",
    version,
    ...(node ? { engines: { node } } : {}),
    ...(schema === undefined ? {} : { openclaw: { schemaVersions: { state: schema, agent: 19 } } }),
  });
  vi.mocked(shared.resolveTargetVersion).mockResolvedValue({ version: null });
  return candidate;
}

function prepareCurrentUpdate() {
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", "external");
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
  writeConfig({ plugins: { enabled: false }, gateway: { mode: "local" } });
  openOpenClawStateDatabase();
  allowPackageRuntime();
  writeFreshJson(path.join(fixture.root, "package.json"), { name: "openclaw", version: VERSION });
  vi.mocked(shared.resolveTargetVersion).mockResolvedValue({ version: VERSION });
  vi.mocked(updateCheck.resolveNpmChannelTag).mockResolvedValue({
    tag: "latest",
    version: VERSION,
  });
  vi.mocked(packageMetadata.fetchNpmPackageTargetStatus).mockResolvedValue({
    ...targetMetadata,
    version: VERSION,
    schemaVersions: { state: OPENCLAW_STATE_SCHEMA_VERSION, agent: OPENCLAW_AGENT_SCHEMA_VERSION },
  });
}

describe("update command admission with fresh state", () => {
  it("requires fresh downgrade confirmation without creating a run or exiting before release", async () => {
    await expect(
      updateCommand({ admission: "installed", tag: "2026.9.2", json: true, restart: false }),
    ).rejects.toMatchObject({ code: 1 });
    expect(defaultRuntime.writeJson).toHaveBeenCalledOnce();
    expectJson({ status: "skipped", reason: "downgrade-confirmation-required" });
    expect(createManagedHandoffLeaseStore().read(fixture.root).kind).toBe("absent");
    expectFreshStatePreserved(fixture);
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
      await expect(
        updateCommand({ admission: "installed", tag: "2026.9.2", restart: false }),
      ).rejects.toMatchObject({ code: 0 });
    });
    expect(leases).toEqual(["absent"]);
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    expectFreshStatePreserved(fixture);
  });

  it.each([
    { dryRun: false, existing: false },
    { dryRun: true, existing: false },
    { dryRun: false, existing: true },
  ])(
    "reports an invalid dev target after settlement (dry run=$dryRun, existing=$existing)",
    async ({ dryRun, existing }) => {
      const config = writeStoredChannel("dev");
      const configBytes = JSON.stringify({ update: { channel: "dev" } });
      const packagePath = path.join(fixture.root, "package.json");
      const packageBytes = fs.readFileSync(packagePath, "utf8");
      if (existing) {
        openOpenClawStateDatabase();
        await closeOpenClawStateDatabaseAsync();
      }
      vi.spyOn(devUpdateTarget, "readDevUpdateTarget").mockImplementation(() => {
        throw new Error("fixture invalid dev target");
      });
      const triage = vi.spyOn(commandTriage, "prepareUpdateCommandFailureTriage");
      const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
        throw new ExitError(code);
      });
      await expect(
        invokeUpdateCli({ tag: "2026.9.2", yes: true, json: true, restart: false, dryRun }),
      ).rejects.toMatchObject({ code: 1 });
      if (existing) {
        expect(
          vi
            .mocked(defaultRuntime.error)
            .mock.calls.filter(([message]) => message === "fixture invalid dev target"),
        ).toEqual([["fixture invalid dev target"]]);
      } else {
        expect(defaultRuntime.error).toHaveBeenCalledExactlyOnceWith("fixture invalid dev target");
      }
      expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(dryRun ? 0 : 1);
      if (!dryRun) {
        expectJson({ status: "error", reason: "invalid-dev-target" });
      }
      if (existing) {
        const result = vi.mocked(defaultRuntime.writeJson).mock.calls[0]?.[0];
        assert(isRecord(result) && typeof result.runId === "string");
        expect(getUpdateRun(result.runId)).toMatchObject({
          runId: result.runId,
          phase: "finished",
          status: "failed",
          reason: "invalid-dev-target",
        });
        expect(packageUpdate.stagePackageInstallUpdate).not.toHaveBeenCalled();
        expect(fs.readdirSync(fixture.root)).toEqual(["package.json"]);
      } else {
        expect(triage).not.toHaveBeenCalled();
        expectFreshStatePreserved(fixture);
      }
      expect(exit).not.toHaveBeenCalled();
      expect(createManagedHandoffLeaseStore().read(fixture.root).kind).toBe("absent");
      expect(fs.readFileSync(config, "utf8")).toBe(configBytes);
      expect(fs.readFileSync(packagePath, "utf8")).toBe(packageBytes);
    },
  );

  it("closes the stage when successful initialization is followed by legacy release failure", async () => {
    allowPackageRuntime();
    const staged = createStage(fixture.root);
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(staged);
    vi.spyOn(initialization, "initializeUpdateStateFromTarget").mockImplementation(async () => {
      createSelectedTargetStateDatabase(fixture.databasePath);
    });
    const releaseError = new Error("fixture successful initialization release failed");
    const release = vi.fn(() => {
      throw releaseError;
    });
    vi.spyOn(initialization, "acquireLegacyUpdateInitializationFence").mockReturnValue({
      assertCurrent() {},
      run: (operation) => operation(),
      release,
    });
    await expect(runUpdate()).rejects.toBe(releaseError);
    expect(staged.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(staged.run).not.toHaveBeenCalled();
    expect(createManagedHandoffLeaseStore().read(fixture.root).kind).toBe("absent");
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
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
      allowPackageRuntime();
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
            denyFreshLeaseRelease("fixture final lease delete denied");
          }
        }),
      };
      vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(staged);
      vi.spyOn(initialization, "initializeUpdateStateFromTarget").mockImplementation(async () => {
        expect(fs.existsSync(fixture.databasePath)).toBe(false);
        createSelectedTargetStateDatabase(fixture.databasePath);
      });
      vi.spyOn(execution, "executeMutableUpdate").mockImplementation(async (params) => {
        // The installation work is complete; keep its real terminal publisher,
        // ledger, executor, and outer staged-package cleanup to prove ordering.
        admittedRun = params.opts.run;
        expect(triagePrepared).toBe(true);
        const result = updateResult({ root: fixture.root });
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

      const outcome = await runUpdate({ tag: "2026.9.2" }).then(
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
      expectJson({ status: fault === "healthy" ? "ok" : "error" });
      expect(getUpdateRun(admittedRun.runId, { env: admittedRun.env })?.status).toBe(
        fault === "healthy" ? "succeeded" : "failed",
      );
      expect(outcome === undefined).toBe(fault === "healthy");
    },
  );

  it("registered update CLI reports the installed version for fresh saved-dev previews", async () => {
    writeStoredChannel("dev");
    vi.stubEnv("OPENCLAW_GIT_DIR", path.join(fixture.root, "missing-checkout"));
    const program = new Command();
    registerUpdateCli(program);

    await program.parseAsync(["update", "--dry-run", "--json", "--no-restart"], { from: "user" });

    expectJson({
      currentVersion: "2026.9.3",
      targetVersion: null,
      targetVersionReason: expect.stringContaining("Git"),
      switchToGit: true,
    });
    expect(vi.mocked(defaultRuntime.writeJson).mock.calls[0]?.[0]).toHaveProperty("run", undefined);
    expectFreshStatePreserved(fixture);
  });

  it("previews an older stable without runtime state despite an inherited run", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", inheritedRunIds[0]);
    await updateCommand({ tag: "2026.9.2", dryRun: true, json: true, restart: false });

    expectJson({
      dryRun: true,
      currentVersion: "2026.9.3",
      targetVersion: "2026.9.2",
      downgradeRisk: true,
    });
    expectFreshStatePreserved(fixture);
  });

  it.each([{ channel: "stable" }, { tag: "latest" }])(
    "refuses unresolved registry metadata for %j before creating runtime state",
    async (target) => {
      vi.mocked(shared.resolveTargetVersion).mockResolvedValue({ version: null });
      vi.mocked(updateCheck.resolveNpmChannelTag).mockResolvedValue({
        tag: "latest",
        version: null,
      });

      await expect(runUpdate(target)).rejects.toMatchObject({ code: 1 });

      expectMetadataFailure({ code: "target-registry-dist-tag" }, { status: "error" });
      expectFreshStatePreserved(fixture);
    },
  );

  it("selects the fresh managed profile's stored channel instead of the shell profile's channel", async () => {
    const shellConfigPath = writeStoredChannel("stable");
    const serviceStateDir = dirs.make("openclaw-update-managed-profile-");
    const serviceConfigPath = path.join(serviceStateDir, "openclaw.json");
    writeFreshJson(serviceConfigPath, { update: { channel: "beta" } });
    const serviceEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: serviceStateDir,
      OPENCLAW_CONFIG_PATH: serviceConfigPath,
    };
    vi.spyOn(commandRun, "resolveUpdateCommandAdmissionEnv").mockResolvedValue(serviceEnv);
    vi.spyOn(runtimePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: false,
      error: "fixture-stop",
    });
    vi.mocked(updateCheck.resolveNpmChannelTag).mockResolvedValue({
      tag: "beta",
      version: "2026.9.2",
    });

    await expect(runUpdate({ admission: "installed" })).rejects.toMatchObject({ code: 1 });

    expect(
      vi.mocked(updateCheck.resolveNpmChannelTag).mock.calls.map(([params]) => params.channel),
    ).toEqual(["beta"]);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath(serviceEnv))).toBe(false);
    expect(process.env.OPENCLAW_CONFIG_PATH).toBe(shellConfigPath);
    expectJson({ status: "error", reason: "node-runtime-preflight" });
    expectFreshStatePreserved(fixture);
  });

  it("accepts target Doctor config changes that preserve the selected stored channel", async () => {
    const configPath = writeStoredChannel("stable");
    allowPackageRuntime();
    const staged = createStage(fixture.root);
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
        writeFreshJson(configPath, migrated);
        await params.checkSchemas();
        throw afterDoctor;
      },
    );

    await expect(runUpdate()).rejects.toBe(afterDoctor);

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
    allowPackageRuntime();
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

it.each([
  { schema: 16, version: "2026.9.2", code: undefined, timeoutMs: undefined },
  { schema: 16, version: "2026.9.2", code: undefined, timeoutMs: 5000 },
  { schema: undefined, version: "2026.9.2", code: "target-schema-metadata" },
  { schema: 16, version: "invalid", code: "target-version-resolution" },
])(
  "inspects artifact $version schema $schema with deadline $timeoutMs before initialization and history",
  async ({ schema, version, code, timeoutMs }) => {
    const prepare = vi.mocked(commandRun.prepareUpdateCommand).getMockImplementation()!;
    vi.mocked(commandRun.prepareUpdateCommand).mockImplementation(async (...args) => {
      const prepared = await prepare(...args);
      return prepared ? { ...prepared, timeoutMs } : prepared;
    });
    const candidate = createArtifact(version, schema, ">=22");
    const staged = createStage(candidate);
    let privateState: string | undefined;
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockImplementation(async (params) => {
      expect(params.timeoutMs).toBe(timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS);
      expect(params.workTimeoutMs).toBe(timeoutMs ?? null);
      privateState = params.installEnv?.OPENCLAW_STATE_DIR;
      expect(privateState).not.toBe(process.env.OPENCLAW_STATE_DIR);
      expect(params.installEnv?.HOME).toBe(process.env.HOME);
      expect(params.managedServiceEnv?.OPENCLAW_STATE_DIR).toBe(process.env.OPENCLAW_STATE_DIR);
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
      return staged;
    });
    const runtime = vi
      .spyOn(runtimePlan, "resolvePackageRuntimePreflight")
      .mockResolvedValue({ ok: true, value: {} });
    const doctor = vi
      .spyOn(initialization, "initializeUpdateStateFromTarget")
      .mockImplementation(async (params) => {
        expect(params.timeoutMs).toBe(timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS);
        expect(params.workTimeoutMs).toBe(timeoutMs ?? null);
        expect(params.root).toBe(candidate);
        expect(params.env.OPENCLAW_STATE_DIR).toBe(process.env.OPENCLAW_STATE_DIR);
        expect(fs.existsSync(fixture.databasePath)).toBe(false);
        if (schema === 16) {
          createSelectedTargetStateDatabase(fixture.databasePath);
        } else {
          openOpenClawStateDatabase();
          closeOpenClawStateDatabaseForTest();
        }
      });
    const admission = vi
      .spyOn(commandRun, "admitUpdateCommandRun")
      .mockRejectedValue(new Error("artifact-admitted"));
    const outcome = await runUpdate({ tag: "file:/fixture/candidate.tgz" }).then(
      () => "completed",
      (error: unknown) => (error instanceof Error ? error.message : "unknown"),
    );
    expect(staged.close).toHaveBeenCalledOnce();
    expect(privateState).toBeDefined();
    expect(fs.existsSync(path.dirname(privateState!))).toBe(false);
    if (code) {
      expectNoFreshCalls(doctor, admission);
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
      expectMetadataFailure({ code, message: expect.stringContaining("openclaw update --tag") });
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
    const candidate = createArtifact("2026.9.2", 16, ">=22");
    let previous: Buffer | undefined;
    const stage = createStage(candidate);
    vi.mocked(packageUpdate.stagePackageInstallUpdate).mockImplementation(async () => {
      if (fault === "concurrent-state") {
        openOpenClawStateDatabase();
        closeOpenClawStateDatabaseForTest();
        previous = fs.readFileSync(fixture.databasePath);
      }
      return stage;
    });
    vi.spyOn(runtimePlan, "resolvePackageRuntimePreflight").mockResolvedValue({
      ok: false,
      error: "selected artifact requires a newer Node",
    });
    const doctor = vi.spyOn(initialization, "initializeUpdateStateFromTarget");
    const admission = vi.spyOn(commandRun, "admitUpdateCommandRun");
    await runUpdate({ tag: "file:/fixture/candidate.tgz" }).catch(() => undefined);
    expectJson({
      reason: fault === "node" ? "node-runtime-preflight" : "database-schema-preflight",
    });
    expectNoFreshCalls(doctor, admission, stage.run);
    expect(stage.close).toHaveBeenCalledOnce();
    if (previous) {
      expect(fs.readFileSync(fixture.databasePath)).toEqual(previous);
    } else {
      expect(fs.existsSync(fixture.databasePath)).toBe(false);
    }
  },
);

it("requires confirmation for an inspected older artifact without a TTY", async () => {
  const candidate = createArtifact("2026.9.2", 16);
  const stage = createStage(candidate);
  vi.mocked(packageUpdate.stagePackageInstallUpdate).mockResolvedValue(stage);
  allowPackageRuntime();
  const doctor = vi
    .spyOn(initialization, "initializeUpdateStateFromTarget")
    .mockRejectedValue(new Error("confirmation was bypassed"));
  const admission = vi.spyOn(commandRun, "admitUpdateCommandRun");
  await updateCommand({ tag: "file:/fixture/older.tgz", json: true, restart: false }).catch(
    () => undefined,
  );
  expectJson({ status: "skipped", reason: "downgrade-confirmation-required" });
  expectNoFreshCalls(doctor, admission);
  expect(stage.close).toHaveBeenCalledOnce();
  expect(fs.existsSync(fixture.databasePath)).toBe(false);
});

registerOriginalCaptureTests({ fixture, dirs });

it("continues a completed update when original-state capture fails", async () => {
  try {
    prepareCurrentUpdate();
    const cause = "SQLite file generation changed while reading: /fixture/state/openclaw.sqlite";
    vi.spyOn(recoveryBaseline, "captureUpdateRecoveryBaseline").mockRejectedValue(
      new Error("Original update capture failed; evidence retained at /fixture/capture", {
        cause: new Error(cause),
      }),
    );

    await expect(runUpdate()).resolves.toBeUndefined();

    const [finished] = history.listUpdateRuns();
    expect(finished).toMatchObject({ status: "skipped", reason: "already-current" });
    const warning = finished?.steps.find(
      (step) => step.step === "warning:original-state-capture:1",
    )?.detail;
    assert(warning);
    expect(warning).toMatch(
      /^Original state capture is unavailable; the update continues without it\. A running Gateway or another active writer changing state during capture is expected to cause this\. Database rollback uses the pre-migration snapshots taken after the Gateway stops\. A completed update does not need to be restarted because of this warning\. Cause: Original update capture failed; evidence retained at /,
    );
    expect(warning).toContain(cause);
    expect(warning).not.toContain("retry");
    expect(defaultRuntime.error).toHaveBeenCalledWith(`Warning: ${warning}`);
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
});

it("Doctor sees an already-current update's completed history after original-state capture", async () => {
  try {
    prepareCurrentUpdate();
    let running: Awaited<ReturnType<typeof history.getUpdateRunAsync>>;
    const prepareTriage = commandTriage.prepareUpdateCommandFailureTriage;
    vi.spyOn(commandTriage, "prepareUpdateCommandFailureTriage").mockImplementation(
      async (...args) => {
        const triage = await prepareTriage(...args);
        assert(args[0].run);
        const active = await history.listUpdateRunsAsync({ active: true, limit: 100 });
        running = active.find((run) => run.runId === args[0].run?.runId);
        return triage;
      },
    );

    const failure = await runUpdate().catch((error: unknown) => error);
    expect(failure, JSON.stringify(vi.mocked(defaultRuntime.writeJson).mock.calls)).toBeUndefined();

    expect(running).toMatchObject({ status: "running", finishedAtMs: null });
    const [finished] = history.listUpdateRuns();
    assert(finished && running);
    expect(finished.runId).toBe(running.runId);
    expect(finished).toMatchObject({
      phase: "finished",
      status: "skipped",
      reason: "already-current",
      finishedAtMs: expect.any(Number),
      steps: expect.arrayContaining([
        expect.objectContaining({ step: "original-state-capture", status: "completed" }),
      ]),
    });
    // Drain the fixture's writers so the independent Doctor capture has a quiescent source.
    await closeOpenClawStateDatabaseAsync();
    const readHistory = vi.spyOn(history, "listUpdateRunsAsync");
    vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(fixture.root);
    // Keep Doctor admission, original capture, config preflight, and history real;
    // unrelated plugin and platform diagnostic contributions have their own coverage.
    vi.spyOn(doctorContributions, "runDoctorHealthContributions").mockResolvedValue(undefined);
    const runtime = { ...defaultRuntime, log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await doctorCommand(runtime, {
      repair: true,
      nonInteractive: true,
      yes: true,
      workspaceSuggestions: false,
    });

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(history.getUpdateRun(finished.runId)).toEqual(finished);
    expect(readHistory).toHaveBeenCalledWith({ active: true, limit: 100 });
    const activeRead = readHistory.mock.calls.findIndex(([input]) => input?.active === true);
    await expect(readHistory.mock.results[activeRead]!.value).resolves.toEqual([]);
    const completedRead = readHistory.mock.calls.findIndex(([input]) => input?.active !== true);
    await expect(readHistory.mock.results[completedRead]!.value).resolves.toContainEqual(finished);
    expect(runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining(
        "Recovery copy saved before repair. No action needed. For manual recovery:",
      ),
    );
    expect(runtime.error.mock.calls.flat().join("\n")).not.toContain("remains recorded as running");
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
});
