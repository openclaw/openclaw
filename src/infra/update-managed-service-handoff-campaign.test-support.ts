import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import type { ManagedServiceBoundaryOptions } from "./update-managed-service-handoff-boundary-contract.test-support.js";
import type { ManagedServiceManagerBoundaryResult } from "./update-managed-service-handoff-lifecycle.test-support.js";
import { renderUpdateRunReport } from "./update-run-report.js";
import type { UpdateRunResult } from "./update-runner-types.js";

export function registerManagedCampaignFailureTests(
  runManagedServiceManagerBoundary: (
    kind: "systemd",
    options?: ManagedServiceBoundaryOptions,
  ) => Promise<ManagedServiceManagerBoundaryResult>,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
): void {
  itUnix.each([undefined, "consumed-before-exit"] as const)(
    "records the child's early refusal without its notification (%s)",
    async (updaterNotification) => {
      const reason = "update-recovery-pending";
      const repair =
        "Retained package activation is prepared. Run openclaw update repair before retrying.";
      const facts = [
        {
          check: "package-activation",
          code: reason,
          message: "Package publication is incomplete.",
        },
      ];
      const { commands, parentSignal, run, state, sentinel, sensitiveFilesRemoved } =
        await runManagedServiceManagerBoundary("systemd", {
          ledger: true,
          trigger: "campaign",
          controlDisconnect: "transferred",
          validationResult: "child-result",
          helperExitCode: 7,
          updaterNotification,
          updaterResult: {
            status: "error",
            mode: "npm",
            reason,
            recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
            steps: [
              {
                name: "package-activation",
                command: "openclaw update",
                cwd: "",
                durationMs: 0,
                exitCode: 1,
                failureFacts: facts,
                diagnostics: [repair],
                stdoutTail: updaterNotification ? undefined : "diagnostic context ".repeat(4_000),
              },
            ],
            durationMs: 0,
          } satisfies UpdateRunResult,
        });
      expect(commands).toEqual([]);
      expect(parentSignal).toBeNull();
      expect(state.parked).toBeUndefined();
      expect(state.restored).toBeUndefined();
      expect(sentinel).toBeNull();
      expect(sensitiveFilesRemoved).toBe(true);
      const recorded = expectDefined(run, "closed campaign run");
      expect(recorded).toMatchObject({ status: "failed", phase: "finished", reason });
      expect(recorded.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            step: "package-activation",
            status: "failed",
            failureFacts: facts,
          }),
          expect.objectContaining({ step: "diagnostic:package-activation", detail: repair }),
          expect.objectContaining({
            step: "managed-service-handoff",
            status: "failed",
            detail: "managed-service-handoff-failed",
          }),
        ]),
      );
      const report = renderUpdateRunReport(recorded).markdown;
      expect(report).toContain(reason);
      expect(report).toContain("Package publication is incomplete.");
    },
  );

  itUnix("keeps the handoff failure reason when the child produces no result", async () => {
    const { commands, run } = await runManagedServiceManagerBoundary("systemd", {
      ledger: true,
      trigger: "campaign",
      controlDisconnect: "transferred",
      validationResult: "child-result",
      updaterOutput: "missing",
      helperExitCode: 7,
    });
    expect(commands).toEqual([]);
    expect(run).toMatchObject({ status: "failed", reason: "managed-service-handoff-failed" });
  });

  itUnix.each([false, true])(
    "preserves an automatic transfer failure through real helper cancellation (diagnostics fail=%s)",
    async (diagnosticFailure) => {
      const reason = "managed-service-handoff-failed";
      const { commands, parentSignal, run, sentinel } = await runManagedServiceManagerBoundary(
        "systemd",
        {
          ledger: true,
          trigger: "campaign",
          controlDisconnect: "unarmed",
          beforeDisconnect: async (admittedRun, env) => {
            const handoff = await import("./update-managed-service-handoff.js");
            const { runAutoUpdateCommand } = await import("./update-startup-auto-run.js");
            const supervisor = vi
              .spyOn(await import("./supervisor-markers.js"), "detectRespawnSupervisor")
              .mockReturnValue("systemd");
            const start = vi
              .spyOn(handoff, "startManagedServiceUpdateHandoff")
              .mockResolvedValueOnce({
                status: "started",
                handoffId: "systemd-boundary",
                installRoot: expectDefined(env.OPENCLAW_STATE_DIR, "fixture install root"),
                command: "openclaw update --channel beta",
                logPath: "fixture-handoff.log",
              });
            let restoreDiagnosticFailure: (() => void) | undefined;
            const transfer = vi
              .spyOn(handoff, "transferManagedServiceUpdateHandoff")
              .mockImplementationOnce(async () => {
                if (diagnosticFailure) {
                  const worker = await import("../state/openclaw-state-worker-store.js");
                  const execute = worker.runOpenClawStateWorkerOperation;
                  const write = vi
                    .spyOn(worker, "runOpenClawStateWorkerOperation")
                    // Keep the requested failure durable, then reject its optional diagnostics.
                    .mockImplementationOnce(execute)
                    .mockRejectedValueOnce(new Error("diagnostic ledger is read-only"));
                  restoreDiagnosticFailure = () => write.mockRestore();
                }
                throw new Error("automatic transfer failed");
              });
            // The fixture closes the real helper's control pipe after the producer returns.
            const cancel = vi
              .spyOn(handoff, "cancelManagedServiceUpdateHandoff")
              .mockResolvedValueOnce("restored-in-process");
            const log = { info: vi.fn() };
            try {
              const outcome = await withEnvAsync(
                {
                  OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR,
                  OPENCLAW_CONFIG_PATH: env.OPENCLAW_CONFIG_PATH,
                },
                () =>
                  runAutoUpdateCommand(
                    {
                      runId: expectDefined(admittedRun, "admitted campaign run").runId,
                      channel: "beta",
                      mode: "npm",
                      root: env.OPENCLAW_STATE_DIR,
                      timeoutMs: 1_000,
                      restartDrainTimeoutMs: undefined,
                    },
                    log,
                  ),
              );
              expect(outcome).toMatchObject({
                status: "failed",
                result: {
                  reason,
                  steps: [
                    expect.objectContaining({
                      failureFacts: [
                        expect.objectContaining({ message: "automatic transfer failed" }),
                      ],
                    }),
                  ],
                },
              });
              expect(cancel).toHaveBeenCalledOnce();
              if (diagnosticFailure) {
                expect(log.info).toHaveBeenCalledWith(
                  expect.stringContaining("Update diagnostics could not be recorded"),
                );
              }
            } finally {
              restoreDiagnosticFailure?.();
              cancel.mockRestore();
              transfer.mockRestore();
              start.mockRestore();
              supervisor.mockRestore();
            }
          },
        },
      );
      expect(commands).toEqual([]);
      expect(parentSignal).toBeNull();
      expect(run).toMatchObject({
        status: "failed",
        reason,
        steps: expect.arrayContaining([
          expect.objectContaining({
            step: "requested",
            status: "failed",
          }),
        ]),
      });
      if (!diagnosticFailure) {
        expect(run?.steps).toContainEqual(
          expect.objectContaining({
            step: "managed-service",
            status: "failed",
            failureFacts: [
              expect.objectContaining({
                check: "managed-service",
                message: "automatic transfer failed",
              }),
            ],
          }),
        );
      }
      expect(sentinel).toMatchObject({ payload: { status: "error", stats: { reason } } });
    },
  );
}
