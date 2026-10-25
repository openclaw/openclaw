import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import type { ManagedServiceBoundaryOptions } from "./update-managed-service-handoff-boundary-contract.test-support.js";
import type { ManagedServiceManagerBoundaryResult } from "./update-managed-service-handoff-lifecycle.test-support.js";
import { renderUpdateRunReport } from "./update-run-report.js";
import type { UpdateRunResult } from "./update-runner-types.js";

const failedStep = (step: string, details: object = {}) =>
  expect.objectContaining({ step, status: "failed", ...details });

export function registerManagedCampaignFailureTests(
  runManagedServiceManagerBoundary: (
    kind: "systemd",
    options?: ManagedServiceBoundaryOptions,
  ) => Promise<ManagedServiceManagerBoundaryResult>,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
): void {
  itUnix.each(["healthy", "failed", undefined] as const)(
    "preserves the updater's recorded recovery in preflight triage (service=%s)",
    async (service) => {
      const { commands, parentSignal, state } = await runManagedServiceManagerBoundary("systemd", {
        controlDisconnect: "transferred",
        validationResult: "child-result",
        helperExitCode: 7,
        updaterResult: {
          status: "error",
          mode: "git",
          reason: "preflight-node-runtime-incompatible",
          recovery: { serviceRestartSafe: true, version: "1.0.0", service },
        },
      });
      expect(commands).toEqual([]);
      expect(parentSignal).toBeNull();
      expect(state.triageCalls).toBe(1);
      expect(state.triageInput).toMatchObject({
        error: expect.stringContaining(
          service === "failed" ? "Service recovery failed." : "Service recovery succeeded.",
        ),
      });
    },
  );

  itUnix.each([
    { updaterNotification: undefined, structuredFacts: false, gatewayHealth: "ready" },
    { updaterNotification: "consumed-before-exit", structuredFacts: true, gatewayHealth: "exited" },
    { updaterNotification: undefined, structuredFacts: true, gatewayHealth: "throw" },
  ] as const)(
    "records the child's early refusal without its notification ($updaterNotification, $gatewayHealth)",
    async ({ updaterNotification, structuredFacts, gatewayHealth }) => {
      const reason = "update-recovery-pending";
      const diagnostic = "Package publication recovery permissions are unsafe.";
      const failureMessage = "Package publication is incomplete.";
      const facts = [{ check: "package-activation", code: reason, message: failureMessage }];
      const { commands, parentSignal, run, state, sentinel, sensitiveFilesRemoved } =
        await runManagedServiceManagerBoundary("systemd", {
          ledger: true,
          trigger: "campaign",
          controlDisconnect: "transferred",
          validationResult: "child-result",
          helperExitCode: 7,
          recoveryTimeoutMs: 30 * 60_000,
          updaterNotification,
          gatewayHealth,
          updaterResult: {
            status: "error",
            mode: "npm",
            reason,
            after: { version: "2.0.0" },
            recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
            steps: [
              {
                name: "package-activation",
                command: "openclaw update",
                cwd: "",
                durationMs: 0,
                exitCode: 1,
                ...(structuredFacts ? { failureFacts: facts } : {}),
                diagnostics: [diagnostic],
                stdoutTail: updaterNotification ? undefined : "diagnostic context ".repeat(4_000),
              },
            ],
            durationMs: 0,
          } satisfies UpdateRunResult,
        });
      expect(commands).toEqual([]);
      expect(parentSignal).toBeNull();
      expect(sentinel).toBeNull();
      expect(sensitiveFilesRemoved).toBe(true);
      expect(state).toMatchObject({
        healthProbeCount: 1,
        expectedVersion: "1.0.0",
        recoveryProbeTimeoutMs: 3000,
      });
      const recorded = expectDefined(run, "closed campaign run");
      expect(recorded).toMatchObject({
        status: "failed",
        phase: "finished",
        reason,
        after: { version: "2.0.0" },
        verification: { recovery: { serviceRestartSafe: false } },
      });
      expect(recorded.steps).toEqual(
        expect.arrayContaining([
          failedStep("package-activation", structuredFacts ? { failureFacts: facts } : {}),
          expect.objectContaining({ step: "diagnostic:package-activation", detail: diagnostic }),
          failedStep("managed-service-handoff", {
            detail: `${reason}: ${structuredFacts ? failureMessage : diagnostic}`,
          }),
        ]),
      );
      const report = renderUpdateRunReport(recorded).markdown;
      expect(report).toContain(
        gatewayHealth === "ready"
          ? "Recorded recovery: verified serving 1.0.0"
          : gatewayHealth === "exited"
            ? "Recorded recovery: not serving (service-not-running)"
            : "Recorded recovery: recovery check failed (gateway-probe-failed)",
      );
      expect(state.triageInput).toMatchObject({
        error: expect.stringContaining(
          gatewayHealth === "ready" ? "Service recovery succeeded." : "Service recovery failed.",
        ),
      });
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
}
