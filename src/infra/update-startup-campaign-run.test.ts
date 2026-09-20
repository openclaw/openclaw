import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { readRestartSentinel } from "./restart-sentinel.js";
import { UpdateCampaignController } from "./update-campaign.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import {
  createUpdateRun,
  finishUpdateRun,
  listUpdateRuns,
  recordUpdateRunVerification,
} from "./update-run-ledger.js";
import { runAutoUpdateCommand, runCampaignUpdate } from "./update-startup-auto-run.js";

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
  scheduleGatewaySigusr1Restart: restart,
}));

function createApplyingCampaign() {
  const campaign = new UpdateCampaignController();
  campaign.announce({
    target: { kind: "package", version: "2.0.0-beta.1" },
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
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  });

  it("cancels a rejected transfer when diagnostic persistence fails", async () => {
    const run = createUpdateRun({ trigger: "campaign", target: { kind: "package" } });
    const log = { info: vi.fn() };
    cancel.mockResolvedValueOnce("restored-in-process");
    let record: MockInstance<typeof import("./update-run-codec.js").encodeRun> | undefined;
    transfer.mockImplementationOnce(async () => {
      record = vi
        .spyOn(await import("./update-run-codec.js"), "encodeRun")
        .mockImplementationOnce(() => {
          throw Object.assign(new Error("diagnostic ledger is read-only"), {
            code: "SQLITE_READONLY",
          });
        });
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
        expect.stringContaining("Update diagnostics could not be recorded (SQLITE_READONLY)"),
      );
    } finally {
      record?.mockRestore();
    }
  });

  it.each([
    { throws: false, diagnosticFailure: null },
    { throws: true, diagnosticFailure: null },
    { throws: true, diagnosticFailure: "read" },
    { throws: true, diagnosticFailure: "write" },
    { throws: true, diagnosticFailure: "stale" },
  ] as const)(
    "preserves cause and verified recovery when transfer throws=$throws and diagnostics=$diagnosticFailure",
    async ({ throws, diagnosticFailure }) => {
      if (throws) {
        transfer.mockRejectedValueOnce(new Error("pipe closed"));
      } else {
        transfer.mockResolvedValueOnce(false);
      }
      let stepsBeforeCancellation: ReturnType<typeof listUpdateRuns>[number]["steps"] = [];
      let beforeCancellation: ReturnType<typeof listUpdateRuns>[number] | undefined;
      cancel.mockImplementationOnce(async () => {
        const run = expectDefined(listUpdateRuns()[0], "admitted campaign run");
        beforeCancellation = run;
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
                const reader = await import("./update-run-reader.js");
                const verificationOwner = await import("./update-run-verification.js");
                const failed = () => {
                  throw Object.assign(new Error("summary diagnostics unavailable"), {
                    code: "SQLITE_READONLY",
                  });
                };
                const fault =
                  diagnosticFailure === "stale"
                    ? vi.spyOn(reader, "getUpdateRun").mockReturnValueOnce(beforeCancellation)
                    : diagnosticFailure === "read"
                      ? vi.spyOn(reader, "readUpdateRunRecord").mockImplementationOnce(failed)
                      : vi
                          .spyOn(verificationOwner, "recordUpdateRunVerificationRecord")
                          .mockImplementationOnce(failed);
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
        if (diagnosticFailure && diagnosticFailure !== "stale") {
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
                      .spyOn(await import("./update-run-ledger.js"), "getUpdateRun")
                      .mockImplementationOnce(fail)
                  : vi
                      .spyOn(await import("./update-run-codec.js"), "encodeRun")
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
