import "./update-late-handoff.test-support.js";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import * as ledger from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import {
  adoptUpdateCampaignMock,
  cancelManagedServiceUpdateHandoffMock,
  detectRespawnSupervisorMock,
  invokeUpdateRun,
  mockGlobalInstallSurface,
  sendGatewayLifecycleNoticeMock,
  sentinelState,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

const lateStep = "managed-service-handoff-finalization";
const sessionKey = "agent:main:slack:dm:C0123ABC:thread:1234567890.123456";
const transferError = () =>
  Object.assign(new Error("Broken pipe transferring update"), { code: "EPIPE" });
type Response = {
  runId: string;
  ok: boolean;
  message?: string;
  result: UpdateRunResult;
  handoff?: unknown;
  sentinel: { persisted: boolean };
};
async function capture(contextOverrides: Record<string, unknown> = {}) {
  let response: Response | undefined;
  await invokeUpdateRun(
    { sessionKey },
    (_ok, value) => {
      response = value as Response;
    },
    undefined,
    contextOverrides,
  );
  const payload = expectDefined(response, "late failure RPC response");
  expect(payload).toMatchObject({ ok: false });
  expect(payload.handoff).toBeUndefined();
  return { payload, run: expectDefined(ledger.getUpdateRun(payload.runId), "durable update run") };
}
async function report(run: NonNullable<ReturnType<typeof ledger.getUpdateRun>>) {
  return (
    await prepareUpdateFailureReport({
      attemptId: run.runId,
      recordedRun: run,
      result: {
        status: "error",
        mode: "npm",
        reason: run.reason ?? undefined,
        steps: [],
        durationMs: 0,
      },
    })
  ).body;
}
function managed() {
  detectRespawnSupervisorMock.mockReturnValue("launchd");
  mockGlobalInstallSurface();
}

describe("late managed handoff failure preservation", () => {
  it("retains both admission-record and transfer causes in reopened history and report", async () => {
    managed();
    const record = ledger.recordUpdateRunStep;
    const admissionError = Object.assign(new Error("Accepted handoff could not be recorded"), {
      code: "EIO",
    });
    const write = vi
      .spyOn(ledger, "recordUpdateRunStep")
      .mockImplementation((runId, step, ...rest) => {
        if (step.step === "managed-service update handoff" && step.status === "completed") {
          throw admissionError;
        }
        return record(runId, step, ...rest);
      });
    transferManagedServiceUpdateHandoffMock.mockRejectedValueOnce(transferError());
    try {
      const { payload, run } = await capture();
      expect(payload.result.steps).toMatchObject([
        { name: "requested", failureFacts: [{ check: "managed-service", code: "EIO" }] },
        { name: lateStep, failureFacts: [{ check: "managed-service", code: "EPIPE" }] },
      ]);
      expect(run.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            step: "requested",
            status: "failed",
            failureFacts: payload.result.steps[0]?.failureFacts,
          }),
          expect.objectContaining({
            step: lateStep,
            status: "failed",
            failureFacts: payload.result.steps[1]?.failureFacts,
          }),
        ]),
      );
      expect(run.steps.some((step) => step.step === "managed-service update handoff")).toBe(false);
      const body = await report(run);
      for (const text of [JSON.stringify(payload.result), JSON.stringify(run), body]) {
        expect(text).toContain("EIO");
        expect(text).toContain("EPIPE");
        expect(text).toContain(admissionError.message);
        expect(text).toContain(transferError().message);
      }
      expect(cancelManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    } finally {
      write.mockRestore();
    }
  });

  it.each(["sentinel-write", "transfer-rejected", "transfer-error", "cancel-error"] as const)(
    "persists %s cause before cancellation without changing completed custody",
    async (failure) => {
      managed();
      const original =
        failure === "sentinel-write"
          ? Object.assign(new Error("Permission denied saving restart notice"), { code: "EACCES" })
          : transferError();
      if (failure === "sentinel-write") {
        sentinelState.restartSentinelWriteError = original;
      } else if (failure === "transfer-rejected") {
        transferManagedServiceUpdateHandoffMock.mockResolvedValueOnce(false);
      } else {
        transferManagedServiceUpdateHandoffMock.mockRejectedValueOnce(original);
      }
      const code = failure === "transfer-rejected" ? "Error" : original.code;
      let beforeCancellation: ReturnType<typeof ledger.getUpdateRun>;
      cancelManagedServiceUpdateHandoffMock.mockImplementationOnce(async () => {
        const runId = expectDefined(
          startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0].runId,
          "started run",
        );
        beforeCancellation = structuredClone(ledger.getUpdateRun(runId));
        await Promise.resolve();
        if (failure === "cancel-error") {
          throw new Error("Cancellation pipe also failed");
        }
        ledger.finishUpdateRun(runId, {
          status: "failed",
          reason: "managed-service-handoff-failed",
        });
        return "restored-in-process";
      });
      const { payload, run } = await capture();
      expect(beforeCancellation).toMatchObject({
        status: "running",
        steps: expect.arrayContaining([
          expect.objectContaining({
            step: "managed-service update handoff",
            status: "completed",
          }),
          expect.objectContaining({
            step: lateStep,
            status: "failed",
            failureFacts: [expect.objectContaining({ code })],
          }),
        ]),
      });
      expect(payload.sentinel.persisted).toBe(failure !== "sentinel-write");
      expect(payload.result.steps).toMatchObject([
        { name: "managed-service update handoff" },
        { name: lateStep, failureFacts: [{ check: "managed-service", code }] },
      ]);
      expect(run.status).toBe("failed");
      expect(run.steps.find((step) => step.step === "managed-service update handoff")?.status).toBe(
        "completed",
      );
      expect(await report(run)).toContain(
        failure === "transfer-rejected"
          ? "Managed update ownership transfer was not acknowledged"
          : original.message,
      );
      expect(JSON.stringify(payload.result)).not.toContain("Cancellation pipe also failed");
      expect(cancelManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
      expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(
        failure === "sentinel-write" ? 0 : 1,
      );
    },
  );

  it("joins cancellation before returning the retained failure", async () => {
    managed();
    transferManagedServiceUpdateHandoffMock.mockRejectedValueOnce(transferError());
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    cancelManagedServiceUpdateHandoffMock.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return "restored-in-process";
    });
    let settled = false;
    const pending = capture().finally(() => {
      settled = true;
    });
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("RPC settled before entering cancellation");
        }),
      ]);
      // Drain the handler continuations while cancellation is still blocked.
      await setImmediate();
      expect(settled).toBe(false);
      const runId = expectDefined(
        startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0].runId,
        "started run",
      );
      // Terminal history must also wait; later notifications can delay the RPC alone.
      expect(ledger.getUpdateRun(runId)?.status).toBe("running");
      expect(ledger.getUpdateRun(runId)?.steps).toContainEqual(
        expect.objectContaining({ step: lateStep, status: "failed" }),
      );
    } finally {
      release.resolve();
      await pending;
    }
  });

  it("distinguishes a retired campaign from a storage failure and retains its replacement", async () => {
    managed();
    const campaign = (await import("../../infra/update-campaign.js")).gatewayUpdateCampaign;
    const saved = Object.getOwnPropertyDescriptors(campaign);
    const clear = vi.fn();
    Object.assign(campaign, { getState: () => ({ id: "replacement-campaign" }), clear });
    adoptUpdateCampaignMock.mockReturnValueOnce({
      status: "adopted",
      campaignId: "retired-campaign",
      target: { kind: "package", version: "2.0.0" },
    });
    try {
      const { payload, run } = await capture();
      expect(payload.sentinel.persisted).toBe(false);
      expect(sentinelState.capturedPayload).toBeUndefined();
      expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(cancelManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
      expect(payload.result.steps.at(-1)).toMatchObject({
        name: lateStep,
        failureFacts: [{ message: "Managed update no longer owns restart notice persistence" }],
      });
      expect(await report(run)).toContain(
        "Managed update no longer owns restart notice persistence",
      );
      expect(clear).not.toHaveBeenCalled();
    } finally {
      for (const key of ["clear", "getState"] as const) {
        const descriptor = saved[key];
        if (descriptor) {
          Object.defineProperty(campaign, key, descriptor);
        } else {
          Reflect.deleteProperty(campaign, key);
        }
      }
    }
  });

  it.each(["step", "diagnostics", "terminal"] as const)(
    "preserves the RPC cause and campaign outcome when the %s write fails",
    async (failure) => {
      managed();
      const campaign = await import("../../infra/update-campaign.js");
      const originalCampaign = campaign.gatewayUpdateCampaign;
      const clear = vi.fn();
      const getState = vi.fn(() => ({ id: "owned-campaign" }));
      const saved = Object.getOwnPropertyDescriptors(originalCampaign);
      Object.assign(originalCampaign, { clear, getState });
      adoptUpdateCampaignMock.mockReturnValueOnce({
        status: "adopted",
        campaignId: "owned-campaign",
        target: { kind: "package", version: "2.0.0" },
      });
      transferManagedServiceUpdateHandoffMock.mockRejectedValueOnce(transferError());
      const record = ledger.recordUpdateRunStep;
      const write = vi
        .spyOn(ledger, "recordUpdateRunStep")
        .mockImplementation((runId, step, ...rest) => {
          if (failure === "step" && step.step === lateStep) {
            throw new Error("late step unavailable");
          }
          return record(runId, step, ...rest);
        });
      const diagnostics = ledger.recordUpdateRunDiagnostics;
      const details = vi
        .spyOn(ledger, "recordUpdateRunDiagnostics")
        .mockImplementation((...args) => {
          if (failure === "diagnostics") {
            throw new Error("late details unavailable");
          }
          return diagnostics(...args);
        });
      const finish = ledger.finishUpdateRun;
      const terminal = vi.spyOn(ledger, "finishUpdateRun").mockImplementation((...args) => {
        if (failure === "terminal") {
          throw new Error("terminal history unavailable");
        }
        return finish(...args);
      });
      try {
        const { payload, run } = await capture({
          logGateway: {
            warn: () => {
              throw new Error("diagnostic sink unavailable");
            },
            info: () => {},
          },
        });
        expect(payload.result.steps.at(-1)).toMatchObject({
          name: lateStep,
          failureFacts: [{ code: "EPIPE", message: `${transferError().message} | EPIPE` }],
        });
        expect(payload.message).toContain("failure history could not be fully saved");
        expect(run.status).toBe(failure === "terminal" ? "running" : "failed");
        expect(clear).toHaveBeenCalledTimes(failure === "terminal" ? 0 : 1);
        if (failure === "terminal") {
          expect(sendGatewayLifecycleNoticeMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining("OpenClaw update failed") }),
            expect.any(Object),
          );
        } else {
          expect(sendGatewayLifecycleNoticeMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ message: expect.stringContaining("OpenClaw update failed") }),
            expect.any(Object),
          );
        }
        expect(cancelManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
        expect(terminal).toHaveBeenCalledOnce();
      } finally {
        write.mockRestore();
        details.mockRestore();
        terminal.mockRestore();
        for (const key of ["clear", "getState"] as const) {
          const descriptor = saved[key];
          if (descriptor) {
            Object.defineProperty(originalCampaign, key, descriptor);
          } else {
            Reflect.deleteProperty(originalCampaign, key);
          }
        }
      }
    },
  );
});
