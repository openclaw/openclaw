import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { UpdatePreMutationError } from "../../cli/update-cli/shared.js";
import {
  buildStatusUpdateRows,
  formatUpdateRestartStatusValue,
} from "../../commands/status-update-restart.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  sentinelState,
  detectRespawnSupervisorMock,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
  cancelManagedServiceUpdateHandoffMock,
  sendGatewayLifecycleNoticeMock,
  scheduleGatewaySigusr1RestartMock,
  captureUpdateRunPayload,
  mockGlobalInstallSurface,
} from "./update.test-harness.js";

describe("update.run handoff refusal diagnostics", () => {
  it.each(["sentinel-write", "transfer-rejected", "transfer-error"])(
    "cancels managed admission and keeps serving after %s failure",
    async (failure) => {
      detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
      mockGlobalInstallSurface();
      if (failure === "sentinel-write") {
        sentinelState.restartSentinelWriteError = new Error("state database unavailable");
      } else if (failure === "transfer-rejected") {
        transferManagedServiceUpdateHandoffMock.mockResolvedValueOnce(false);
      } else {
        transferManagedServiceUpdateHandoffMock.mockRejectedValueOnce(new Error("EPIPE"));
      }
      cancelManagedServiceUpdateHandoffMock.mockImplementationOnce(async () => {
        const started = startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0];
        const runId = expectDefined(started?.runId, "started update run");
        expect(getUpdateRun(runId)).toMatchObject({
          status: "running",
          reason: "managed-service-handoff-failed",
          steps: expect.arrayContaining([
            expect.objectContaining({ step: "requested", status: "failed" }),
          ]),
        });
        finishUpdateRun(runId, {
          status: "failed",
          reason: "managed-service-handoff-failed",
        });
        return "restored-in-process";
      });

      const payload = await captureUpdateRunPayload({
        sessionKey: "agent:main:slack:dm:C0123ABC:thread:1234567890.123456",
      });

      const started = startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0];
      expect(cancelManagedServiceUpdateHandoffMock).toHaveBeenCalledExactlyOnceWith({
        kind: "managed-update-handoff",
        handoffId: started?.handoffId,
        installRoot: "/tmp/openclaw-global",
      });
      expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledTimes(
        failure === "sentinel-write" ? 0 : 1,
      );
      expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
      expect(payload).toMatchObject({
        ok: false,
        restart: null,
        result: { status: "error", reason: "managed-service-handoff-failed" },
      });
      expect(payload?.handoff).toBeUndefined();
      const message =
        failure === "transfer-error" ? "EPIPE" : "managed update ownership transfer failed";
      const run = expectDefined(
        getUpdateRun(expectDefined(payload, "update response").runId),
        "update run",
      );
      const failureFacts = [
        {
          check: "managed-service-handoff-failed",
          code: "managed-service-handoff-failed",
          message,
        },
      ];
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
      expect.soft(report.body).toContain(`Failed phase requested: ${message}`);
      expect(run.steps).toContainEqual(
        expect.objectContaining({ step: "requested", status: "failed", failureFacts }),
      );
      expect(payload?.result).toMatchObject({
        steps: expect.arrayContaining([expect.objectContaining({ failureFacts })]),
      });
      expect(sendGatewayLifecycleNoticeMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(
            "OpenClaw update failed: managed-service-handoff-failed",
          ),
        }),
      );
    },
  );

  it.each([
    {
      error: new Error("ENOENT"),
      reason: "managed-service-handoff-failed",
      message: "ENOENT",
    },
    {
      error: new Error(
        "Managed update handoff requires a user-scope systemd unit; perform a manual system-service update.",
      ),
      reason: "managed-service-handoff-failed",
      message:
        "Managed update handoff requires a user-scope systemd unit; perform a manual system-service update.",
    },
    {
      error: new UpdatePreMutationError("requester-revoked", "requester-revoked", {
        failureFacts: [
          { check: "managed-service", code: "requester-revoked", message: "requester-revoked" },
        ],
      }),
      reason: "requester-revoked",
      message: "requester-revoked",
    },
    {
      error: new Error(
        "managed update handoff exited before signaling readiness (code=1, signal=null)",
      ),
      reason: "managed-service-handoff-failed",
      message: "managed update handoff exited before signaling readiness (code=1, signal=null)",
      publicMessage: "managed update handoff exited before signaling readiness",
    },
    {
      error: new Error("managed update handoff did not signal readiness within 1800 seconds"),
      reason: "managed-service-handoff-failed",
      message: "managed update handoff did not signal readiness within 1800 seconds",
      publicMessage: "managed update handoff did not signal readiness",
    },
  ])(
    "records a handoff refusal: $message",
    async ({ error, reason, message, publicMessage = message }) => {
      detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
      mockGlobalInstallSurface();
      startManagedServiceUpdateHandoffMock.mockRejectedValueOnce(error);

      const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
        captureUpdateRunPayload(),
      );

      expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
      expect(payload?.ok).toBe(false);
      expect(payload?.result).toMatchObject({
        status: "error",
        reason,
      });
      expect(payload?.handoff).toBeUndefined();
      const run = expectDefined(
        getUpdateRun(expectDefined(payload, "update response").runId),
        "update run",
      );
      const report = await prepareUpdateFailureReport({
        attemptId: run.runId,
        recordedRun: run,
        result: { status: "error", mode: "npm", reason, steps: [], durationMs: 0 },
      });
      expect.soft(report.body).toContain(`Failed phase requested: ${publicMessage}`);
      expect.soft(report.body).not.toContain("exit unknown");
      const failureFacts =
        error instanceof UpdatePreMutationError
          ? error.failureFacts
          : [{ check: reason, code: reason, message }];
      expect(run.steps).toContainEqual(
        expect.objectContaining({
          step: "requested",
          status: "failed",
          failureFacts,
        }),
      );
      expect(payload?.result).toMatchObject({ steps: [expect.objectContaining({ failureFacts })] });
      const sentinel = expectDefined(sentinelState.capturedPayload, "restart sentinel");
      expect(sentinel.stats?.steps).toContainEqual(expect.objectContaining({ failureFacts }));
      expect(formatUpdateRestartStatusValue(sentinel)).toContain(message);
      expect(buildStatusUpdateRows(sentinel)).toContainEqual({
        Item: "Update run",
        Value: expect.stringContaining(message),
      });
    },
  );
});
