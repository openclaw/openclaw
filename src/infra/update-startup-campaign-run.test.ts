import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as sentinelStore from "./restart-sentinel.js";
import { readRestartSentinel } from "./restart-sentinel.js";
import { UpdateCampaignController } from "./update-campaign.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import {
  createUpdateRun,
  finishUpdateRun,
  listUpdateRuns,
  recordUpdateRunVerification,
} from "./update-run-ledger.js";
import {
  runAutoUpdateCommand,
  runCampaignUpdate,
  type AutoUpdateRunner,
} from "./update-startup-auto-run.js";
import type { UpdateStepResult } from "./update-step-result.js";

const { cancel, start, transfer, restart } = vi.hoisted(() => ({
  cancel:
    vi.fn<typeof import("./update-managed-service-handoff.js").cancelManagedServiceUpdateHandoff>(),
  start:
    vi.fn<typeof import("./update-managed-service-handoff.js").startManagedServiceUpdateHandoff>(),
  transfer:
    vi.fn<
      typeof import("./update-managed-service-handoff.js").transferManagedServiceUpdateHandoff
    >(),
  restart: vi.fn(),
}));

vi.mock("./supervisor-markers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supervisor-markers.js")>()),
  detectRespawnSupervisor: () => "systemd",
}));
vi.mock("./update-managed-service-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-managed-service-handoff.js")>()),
  cancelManagedServiceUpdateHandoff: cancel,
  startManagedServiceUpdateHandoff: start,
  transferManagedServiceUpdateHandoff: transfer,
}));
vi.mock("./update-triage.js", () => ({
  runUpdateFailureTriage: vi.fn(async () => ({
    status: "completed",
    hint: "Inspect the recorded update failure.",
  })),
}));
vi.mock("./restart.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./restart.js")>()),
  scheduleGatewayRestart: restart,
}));

function createApplyingCampaign(version = "2.0.0-beta.1") {
  const campaign = new UpdateCampaignController(createTestGatewayScheduler());
  campaign.announce({
    target: { kind: "package", version },
    inspect: { getQueueSize: () => 1 },
    apply: async () => "failed",
    onChange: () => {},
  });
  campaign.adopt();
  return campaign;
}

describe("automatic campaign handoff failure", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-campaign-handoff-",
      env: { OPENCLAW_PROFILE: undefined, OPENCLAW_SUPERVISOR_MODE: undefined },
    });
    cancel.mockReset();
    transfer.mockReset();
    restart.mockClear();
    start.mockReset().mockResolvedValue({
      status: "started",
      pid: 12345,
      command: "openclaw update --yes --channel beta",
      logPath: "/tmp/openclaw-handoff.log",
      handoffId: "auto-handoff-id",
      installRoot: "/opt/openclaw",
    });
  });

  afterEach(async () => {
    await closeStateDatabaseForTest();
    await state.cleanup();
  });

  it.each([
    "unchanged",
    "new candidate",
    "manual update",
    "different reason",
    "different check",
    "different detail",
    "transient metadata",
  ] as const)(
    "backs off only identical candidate Doctor failures across restart: %s",
    async (resume) => {
      const log = { info: vi.fn() };
      const step: UpdateStepResult = {
        name: "candidate-doctor",
        command: "doctor",
        cwd: "/private/candidate",
        durationMs: 10,
        exitCode: 1,
        stderrTail: "Plugin dependency is outside the temporary update copy: chromium-bidi",
      };
      const outcome: Awaited<ReturnType<AutoUpdateRunner>> = {
        status: "failed",
        message: "Candidate Doctor failed.",
        result: {
          status: "error",
          mode: "npm",
          reason: "doctor-failed",
          steps: [step],
          durationMs: 10,
        },
      };
      const runAuto = vi.fn<AutoUpdateRunner>(async () => structuredClone(outcome));
      const attempt = async (version = "2.0.0-beta.1") => {
        const campaign = createApplyingCampaign(version);
        try {
          return await runCampaignUpdate({
            channel: "beta",
            mode: "npm",
            version,
            tag: "beta",
            forced: false,
            root: "/opt/openclaw",
            log,
            canApply: () => true,
            campaign,
            onAttempt: () => {},
            runAuto,
          });
        } finally {
          campaign.clear();
        }
      };
      if (resume === "transient metadata") {
        step.failureFacts = [
          {
            check: "doctor",
            code: "doctor-failed",
            message: "Check failed in openclaw-update-canary-Abc123 (5ms)",
          },
        ];
      }
      await attempt();
      if (resume === "different reason") {
        outcome.result.reason = "candidate-checks-timeout";
      } else if (resume === "different check") {
        step.name = "candidate-doctor-lint";
      } else if (resume === "different detail") {
        step.stderrTail = "A different dependency is unavailable: kerberos";
      } else if (resume === "transient metadata") {
        step.failureFacts = [
          {
            check: "doctor",
            code: "doctor-failed",
            message: "Check failed in openclaw-update-canary-Def456 (19ms)",
          },
        ];
      }
      await attempt();
      expect(runAuto).toHaveBeenCalledTimes(2);
      const failures = listUpdateRuns();
      expect(failures).toHaveLength(2);
      await closeStateDatabaseForTest();
      await attempt();
      if (resume.startsWith("different")) {
        expect(runAuto).toHaveBeenCalledTimes(3);
        return;
      }
      expect(runAuto).toHaveBeenCalledTimes(2);
      expect(listUpdateRuns()).toHaveLength(2);
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("Automatic updates paused after repeated candidate-doctor failure"),
        expect.objectContaining({
          version: "2.0.0-beta.1",
          runIds: failures.map((run) => run.runId),
          nextAction: expect.stringContaining("openclaw update"),
        }),
      );
      if (resume === "manual update") {
        const manual = createUpdateRun({ trigger: "cli" });
        finishUpdateRun(manual.runId, { status: "failed", reason: "doctor-failed" });
      }
      await attempt(resume === "new candidate" ? "2.0.0-beta.2" : undefined);
      expect(runAuto).toHaveBeenCalledTimes(
        resume === "new candidate" || resume === "manual update" ? 3 : 2,
      );
    },
  );

  it("does not clear a replacement campaign after sentinel settlement", async () => {
    const campaign = createApplyingCampaign();
    const persisted = createDeferred();
    const release = createDeferred();
    const write = sentinelStore.writeRestartSentinelIfUnchanged;
    const spy = vi
      .spyOn(sentinelStore, "writeRestartSentinelIfUnchanged")
      .mockImplementationOnce(async (params) => {
        const result = await write(params);
        persisted.resolve();
        await release.promise;
        return result;
      });
    const operation = runCampaignUpdate({
      channel: "beta",
      mode: "npm",
      version: "2.0.0-beta.1",
      tag: "beta",
      forced: false,
      root: "/opt/openclaw",
      log: { info: vi.fn() },
      campaign,
      onAttempt: vi.fn(),
      canApply: () => true,
      runAuto: async () => ({
        status: "skipped",
        message: "Already current",
        result: {
          status: "skipped",
          mode: "npm",
          reason: "already-current",
          steps: [],
          durationMs: 0,
        },
      }),
    });
    try {
      await awaitGateBeforeSettlement(
        persisted.promise,
        operation,
        "Campaign did not persist its sentinel",
      );
      campaign.clear();
      campaign.announce({
        target: { kind: "package", version: "3.0.0" },
        inspect: { getQueueSize: () => 1 },
        apply: async () => "failed",
        onChange: () => {},
      });
      const replacement = campaign.getState()?.id;
      release.resolve();
      await expect(operation).resolves.toBe("failed");
      expect(campaign.getState()?.id).toBe(replacement);
    } finally {
      release.resolve();
      await operation;
      spy.mockRestore();
      campaign.clear();
    }
  });

  it.each(["state", "diagnostics"] as const)(
    "cancels a rejected transfer when %s persistence fails",
    async (failure) => {
      const run = createUpdateRun({ trigger: "campaign", target: { kind: "package" } });
      const log = { info: vi.fn() };
      cancel.mockResolvedValueOnce("restored-in-process");
      let record:
        | MockInstance<
            typeof import("../state/openclaw-state-worker-store.js").runOpenClawStateWorkerOperation
          >
        | undefined;
      transfer.mockImplementationOnce(async () => {
        const worker = await import("../state/openclaw-state-worker-store.js");
        const execute = worker.runOpenClawStateWorkerOperation;
        record = vi.spyOn(worker, "runOpenClawStateWorkerOperation");
        if (failure === "diagnostics") {
          record.mockImplementationOnce(execute);
        }
        record.mockRejectedValueOnce(
          Object.assign(new Error("diagnostic ledger is read-only"), {
            code: "SQLITE_READONLY",
          }),
        );
        throw new Error("pipe closed");
      });
      try {
        const outcome = await runAutoUpdateCommand(
          {
            runId: run.runId,
            channel: "beta",
            mode: "npm",
            root: "/opt/openclaw",
            timeoutMs: 1_000,
            restartDrainTimeoutMs: undefined,
          },
          log,
        );
        expect(cancel).toHaveBeenCalledExactlyOnceWith({
          kind: "managed-update-handoff",
          handoffId: "auto-handoff-id",
          installRoot: "/opt/openclaw",
        });
        expect(outcome).toMatchObject({
          status: "failed",
          result: {
            reason: "managed-service-handoff-failed",
            steps: [
              expect.objectContaining({
                failureFacts: [expect.objectContaining({ message: "pipe closed" })],
              }),
            ],
          },
        });
        expect(log.info).toHaveBeenCalledWith(
          expect.stringContaining(
            failure === "state"
              ? "Update failure state could not be recorded"
              : "Update diagnostics could not be recorded (SQLITE_READONLY)",
          ),
        );
      } finally {
        record?.mockRestore();
      }
    },
  );

  it.each([
    { throws: false, diagnosticFailure: null },
    { throws: true, diagnosticFailure: "unavailable" },
  ] as const)(
    "preserves cause and verified recovery when transfer throws=$throws and diagnostics=$diagnosticFailure",
    async ({ throws, diagnosticFailure }) => {
      if (throws) {
        transfer.mockRejectedValueOnce(new Error("pipe closed"));
      } else {
        transfer.mockResolvedValueOnce(false);
      }
      let stepsBeforeCancellation: ReturnType<typeof listUpdateRuns>[number]["steps"] = [];
      cancel.mockImplementationOnce(async () => {
        const run = expectDefined(listUpdateRuns()[0], "admitted campaign run");
        expect(run).toMatchObject({
          reason: "managed-service-handoff-failed",
          steps: expect.arrayContaining([
            expect.objectContaining({ step: "requested", status: "failed" }),
          ]),
        });
        stepsBeforeCancellation = run.steps;
        recordUpdateRunVerification(run.runId, {
          rollbackOutcome: {
            status: "not-needed",
            reason: "The handoff owner verified no package mutation",
          },
        });
        finishUpdateRun(run.runId, { status: "failed", reason: "managed-service-handoff-failed" });
        return "restored-in-process";
      });
      const campaign = createApplyingCampaign();
      const log = { info: vi.fn() };
      const onAttempt = vi.fn();
      let restoreDiagnosticFailure: (() => void) | undefined;
      try {
        await expect(
          runCampaignUpdate({
            channel: "beta",
            mode: "npm",
            version: "2.0.0-beta.1",
            tag: "beta",
            forced: false,
            root: "/opt/openclaw",
            log,
            runAuto: async (params) => {
              const outcome = await runAutoUpdateCommand(params, log);
              if (diagnosticFailure) {
                const worker = await import("../state/openclaw-state-worker-store.js");
                const fault = vi
                  .spyOn(worker, "runOpenClawStateWorkerOperation")
                  .mockRejectedValueOnce(
                    Object.assign(new Error("summary diagnostics unavailable"), {
                      code: "SQLITE_READONLY",
                    }),
                  );
                restoreDiagnosticFailure = () => fault.mockRestore();
              }
              return outcome;
            },
            canApply: () => true,
            campaign,
            onAttempt,
          }),
        ).resolves.toBe("failed");
        expect(onAttempt).toHaveBeenCalledExactlyOnceWith("2.0.0-beta.1");
        expect(stepsBeforeCancellation).toContainEqual(
          expect.objectContaining({
            step: "managed-service",
            status: "failed",
            failureFacts: [expect.objectContaining({ code: "Error" })],
          }),
        );
        expect(cancel).toHaveBeenCalledExactlyOnceWith({
          kind: "managed-update-handoff",
          handoffId: "auto-handoff-id",
          installRoot: "/opt/openclaw",
        });
        expect(restart).not.toHaveBeenCalled();
        const run = expectDefined(listUpdateRuns()[0], "finished campaign run");
        expect(run).toMatchObject({
          status: "failed",
          reason: "managed-service-handoff-failed",
          phase: "finished",
          verification: {
            rollbackOutcome: {
              status: "not-needed",
              reason: "The handoff owner verified no package mutation",
            },
          },
        });
        expect((await readRestartSentinel())?.payload).toMatchObject({
          status: "error",
          stats: { reason: "managed-service-handoff-failed" },
        });
        const report = await prepareUpdateFailureReport({
          attemptId: run.runId,
          recordedRun: run,
          result: {
            status: "error",
            mode: "npm",
            reason: run.reason ?? undefined,
            steps: [],
            durationMs: 0,
          },
        });
        expect(report.body).toContain(
          throws ? "pipe closed" : "managed update ownership transfer failed",
        );
        expect(report.body).toContain("managed-service");
        expect(report.body).toContain("Rollback outcome: not needed");
        if (diagnosticFailure) {
          expect(log.info).toHaveBeenCalledWith(
            expect.stringContaining("Update diagnostics could not be recorded"),
          );
        }
      } finally {
        restoreDiagnosticFailure?.();
        campaign.clear();
      }
    },
  );

  it.each(["read", "write"])(
    "preserves the original campaign exception when diagnostics %s fails",
    async (failure) => {
      const campaign = createApplyingCampaign();
      const original = new Error("automatic update failed");
      const log = { info: vi.fn() };
      let restoreRead: (() => void) | undefined;
      try {
        await expect(
          runCampaignUpdate({
            channel: "beta",
            mode: "npm",
            version: "2.0.0-beta.1",
            tag: "beta",
            forced: false,
            root: "/opt/openclaw",
            log,
            canApply: () => true,
            campaign,
            onAttempt: () => {},
            runAuto: async () => {
              const fail = () => {
                throw new Error("diagnostic persistence unavailable");
              };
              const read =
                failure === "read"
                  ? vi
                      .spyOn(await import("./update-run-reader.js"), "getUpdateRunAsync")
                      .mockImplementationOnce(fail)
                  : vi
                      .spyOn(
                        await import("../state/openclaw-state-worker-store.js"),
                        "runOpenClawStateWorkerOperation",
                      )
                      .mockImplementationOnce(fail);
              restoreRead = () => read.mockRestore();
              throw original;
            },
          }),
        ).rejects.toBe(original);
        const run = expectDefined(listUpdateRuns()[0], "failed campaign run");
        expect(run).toMatchObject({
          status: "failed",
          reason: "unexpected-error",
          ...(failure === "read"
            ? {
                steps: expect.arrayContaining([
                  expect.objectContaining({
                    step: "requested",
                    failureFacts: [expect.objectContaining({ message: "automatic update failed" })],
                  }),
                ]),
              }
            : {}),
        });
        expect(log.info).toHaveBeenCalledWith(
          expect.stringContaining(
            failure === "read"
              ? "Update history could not be read"
              : "Update diagnostics could not be recorded",
          ),
        );
      } finally {
        restoreRead?.();
        campaign.clear();
      }
    },
  );
});
