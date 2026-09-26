import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { UpdatePreMutationError } from "../../cli/update-cli/shared.js";
import {
  buildStatusUpdateRows,
  formatUpdateRestartStatusValue,
} from "../../commands/status-update-restart.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  sentinelState,
  detectRespawnSupervisorMock,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
  cancelManagedServiceUpdateHandoffMock,
  sendGatewayLifecycleNoticeMock,
  scheduleGatewayRestartMock,
  captureUpdateRunPayload,
  mockGlobalInstallSurface,
} from "./update.test-harness.js";

describe("update.run handoff refusal diagnostics", () => {
  it("publishes a recovery action without restarting when the original Node is gone", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();
    startManagedServiceUpdateHandoffMock.mockRejectedValueOnce(
      new UpdatePreMutationError(
        "managed-service-handoff-failed",
        "The Gateway's Node executable was removed. Refresh its service definition with `openclaw gateway install --force`. The serving Gateway has not been stopped.",
      ),
    );

    const payload = await captureUpdateRunPayload();
    const run = getUpdateRun(expectDefined(payload, "update response").runId);
    expect(payload).toMatchObject({
      ok: false,
      result: { status: "error", reason: "managed-service-handoff-failed" },
    });
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(run?.origin.nextAction).toContain("openclaw gateway install --force");
    expect(renderUpdateRunReport(expectDefined(run, "update run")).markdown).toContain(
      "The serving Gateway has not been stopped.",
    );
  });

  it.each(["helper-start", "sentinel-write"] as const)(
    "cancels its exact helper when admission ends during %s",
    async (boundary) => {
      detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
      mockGlobalInstallSurface();
      let current = true;
      if (boundary === "helper-start") {
        const start = expectDefined(
          startManagedServiceUpdateHandoffMock.getMockImplementation(),
          "handoff fixture",
        );
        startManagedServiceUpdateHandoffMock.mockImplementationOnce(async (params) => {
          const started = await start(params);
          current = false;
          return started;
        });
      } else {
        sentinelState.onSentinelWrite = () => {
          current = false;
        };
      }
      const { updateHandlers } = await import("./update.js");
      const respond = vi.fn();
      await expectDefined(
        updateHandlers["update.run"],
        "update handler",
      )({
        params: {},
        respond,
        context: { getRuntimeConfig: () => ({ update: {} }) },
        sessionMutationCommitGuard: () => {
          if (!current) {
            throw new Error("scheduled admission ended");
          }
        },
      } as never);
      const started = expectDefined(
        startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0],
        "started handoff",
      );
      expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(cancelManagedServiceUpdateHandoffMock).toHaveBeenCalledExactlyOnceWith({
        kind: "managed-update-handoff",
        handoffId: started.handoffId,
        installRoot: "/tmp/openclaw-global",
      });
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          ok: false,
          result: expect.objectContaining({ reason: "owner_required" }),
        }),
        undefined,
      );
    },
  );

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
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
      expect(payload).toMatchObject({
        ok: false,
        restart: null,
        result: { status: "error", reason: "managed-service-handoff-failed" },
      });
      expect(payload?.handoff).toBeUndefined();
      const message =
        failure === "sentinel-write"
          ? "state database unavailable"
          : failure === "transfer-error"
            ? "EPIPE"
            : "managed update ownership transfer failed";
      const run = expectDefined(
        getUpdateRun(expectDefined(payload, "update response").runId),
        "update run",
      );
      const failureFacts = [
        expect.objectContaining({
          check: "managed-service",
          code: "Error",
          errorName: "Error",
          message,
        }),
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
      if (failure === "sentinel-write") {
        expect.soft(report.body).toContain("Failing check managed-service (Error)");
        expect.soft(report.body).toContain(message);
      } else {
        expect.soft(report.body).toContain(`Failed phase requested: ${message}`);
      }
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
        expect.any(Object),
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
      error: new UpdatePreMutationError(
        "managed-service-handoff-failed",
        "System-scope Gateway package update cannot write its install root /opt/openclaw. As the installation's owning account (UID 0), run: openclaw update --yes --no-restart. Then run: sudo systemctl restart openclaw-gateway.service",
      ),
      reason: "managed-service-handoff-failed",
      message:
        "System-scope Gateway package update cannot write its install root /opt/openclaw. As the installation's owning account (UID 0), run: openclaw update --yes --no-restart. Then run: sudo systemctl restart openclaw-gateway.service",
      publicMessage: "System-scope Gateway package update cannot write its install root.",
      statusMessage:
        "System-scope Gateway package update cannot write its install root [redacted-path]",
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
    async ({ error, reason, message, publicMessage = message, statusMessage = message }) => {
      detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
      mockGlobalInstallSurface();
      startManagedServiceUpdateHandoffMock.mockRejectedValueOnce(error);

      const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
        captureUpdateRunPayload(),
      );

      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
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
      if (error instanceof UpdatePreMutationError) {
        expect(run.origin.nextAction).toBe(message);
        expect(renderUpdateRunReport(run).markdown).toContain(message);
        expect(report.body).not.toContain("sudo systemctl restart");
      }
      expect.soft(report.body).toContain(`Failed phase requested: ${publicMessage}`);
      expect.soft(report.body).not.toContain("exit unknown");
      const failureFacts =
        error instanceof UpdatePreMutationError
          ? error.failureFacts
          : [
              expect.objectContaining({
                check: "managed-service",
                code: "Error",
                errorName: "Error",
                message,
              }),
            ];
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
      expect(formatUpdateRestartStatusValue(sentinel)).toContain(statusMessage);
      expect(buildStatusUpdateRows(sentinel)).toContainEqual({
        Item: "Update run",
        Value: expect.stringContaining(statusMessage),
      });
    },
  );
});

describe("update.run foreground respawn admission", () => {
  const sessionKey = "agent:main:slack:dm:C0123ABC:thread:1234567890.123456";

  it.each(["git", "global"] as const)(
    "refuses a foreground %s update before acknowledgement when process respawn is disabled",
    async (kind) => {
      if (kind === "global") {
        mockGlobalInstallSurface();
      }
      const response = await withEnvAsync({ OPENCLAW_NO_RESPAWN: "1" }, () =>
        captureUpdateRunPayload({ sessionKey }),
      );

      expect(response).toMatchObject({
        ok: false,
        ackDelivered: false,
        result: { reason: "restart-unavailable" },
        message: expect.stringContaining("OPENCLAW_NO_RESPAWN"),
      });
      const run = getUpdateRun(expectDefined(response, "update response").runId);
      expect(run).toMatchObject({
        phase: "finished",
        reason: "restart-unavailable",
        origin: { nextAction: expect.stringContaining("openclaw update") },
      });
      expect(run?.steps.map(({ step, status }) => ({ step, status }))).toEqual([
        { step: "requested", status: "failed" },
        { step: "installation-inspection", status: "completed" },
      ]);
      expect(sendGatewayLifecycleNoticeMock).not.toHaveBeenCalled();
      expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    },
  );

  it("rechecks foreground respawn after awaiting acknowledgement", async () => {
    await withEnvAsync({ OPENCLAW_NO_RESPAWN: undefined }, async () => {
      sendGatewayLifecycleNoticeMock.mockImplementationOnce(async () => {
        process.env.OPENCLAW_NO_RESPAWN = "1";
        return true;
      });

      const response = await captureUpdateRunPayload({ sessionKey });

      expect(response).toMatchObject({
        ok: false,
        ackDelivered: true,
        result: { reason: "restart-unavailable" },
        message: expect.stringContaining("OPENCLAW_NO_RESPAWN"),
      });
      expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    });
  });

  it.each(["before", "during"] as const)(
    "keeps serving when respawn is disabled %s the parking notification",
    async (timing) => {
      await withEnvAsync({ OPENCLAW_NO_RESPAWN: undefined }, async () => {
        expect(await captureUpdateRunPayload({ sessionKey })).toMatchObject({ ok: true });
        const handoff = expectDefined(
          startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0],
          "prepared handoff",
        );
        if (timing === "before") {
          process.env.OPENCLAW_NO_RESPAWN = "1";
        } else {
          sendGatewayLifecycleNoticeMock.mockImplementationOnce(async () => {
            process.env.OPENCLAW_NO_RESPAWN = "1";
            return true;
          });
        }

        await expect(expectDefined(handoff.beforePark, "parking callback")()).rejects.toThrow(
          "OPENCLAW_NO_RESPAWN",
        );
        expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["launchd", "systemd"] as const)(
    "retains %s-managed updates when foreground respawn is disabled",
    async (supervisor) => {
      detectRespawnSupervisorMock.mockReturnValue(supervisor);
      const response = await withEnvAsync({ OPENCLAW_NO_RESPAWN: "1" }, () =>
        captureUpdateRunPayload(),
      );

      expect(response).toMatchObject({ ok: true, handoff: { status: "started" } });
      expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
        expect.objectContaining({ supervisor }),
      );
      expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    },
  );

  it("admits foreground updates when the respawn policy is explicitly false", async () => {
    const response = await withEnvAsync({ OPENCLAW_NO_RESPAWN: "0" }, () =>
      captureUpdateRunPayload(),
    );
    expect(response).toMatchObject({ ok: true, handoff: { status: "started" } });
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
  });
});
