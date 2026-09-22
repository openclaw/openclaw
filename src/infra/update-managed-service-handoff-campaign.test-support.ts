import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import type { ManagedServiceBoundaryOptions } from "./update-managed-service-handoff-boundary-contract.test-support.js";
import type { ManagedServiceManagerBoundaryResult } from "./update-managed-service-handoff-lifecycle.test-support.js";

export function registerManagedCampaignFailureTests(
  runManagedServiceManagerBoundary: (
    kind: "systemd",
    options?: ManagedServiceBoundaryOptions,
  ) => Promise<ManagedServiceManagerBoundaryResult>,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
): void {
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
                  const codec = await import("./update-run-codec.js");
                  const encode = codec.encodeRun;
                  const write = vi
                    .spyOn(codec, "encodeRun")
                    .mockImplementation((record, options) => {
                      if (
                        record.steps.some((step) =>
                          step.failureFacts?.some((fact) => fact.check === "managed-service"),
                        )
                      ) {
                        write.mockRestore();
                        throw new Error("diagnostic ledger is read-only");
                      }
                      return encode(record, options);
                    });
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
