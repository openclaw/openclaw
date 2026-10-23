import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
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
  detectRespawnSupervisorMock as detectSupervisor,
  startManagedServiceUpdateHandoffMock as startHandoff,
  transferManagedServiceUpdateHandoffMock as transferHandoff,
  cancelManagedServiceUpdateHandoffMock as cancelHandoff,
  sendGatewayLifecycleNoticeMock as sendNotice,
  scheduleGatewayRestartMock as scheduleRestart,
  captureUpdateRunPayload,
  mockGlobalInstallSurface,
} from "./update.test-harness.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function readRun(payload: Awaited<ReturnType<typeof captureUpdateRunPayload>>) {
  return expectDefined(getUpdateRun(expectDefined(payload, "update response").runId), "update run");
}

async function failureReport(run: ReturnType<typeof readRun>, reason?: string) {
  return prepareUpdateFailureReport({
    attemptId: run.runId,
    recordedRun: run,
    result: { status: "error", mode: "npm", reason, steps: [], durationMs: 0 },
  });
}

function errorFact(message: string) {
  return expect.objectContaining({
    check: "managed-service",
    code: "Error",
    errorName: "Error",
    message,
  });
}

function expectServing() {
  expect(scheduleRestart).not.toHaveBeenCalled();
  expect(transferHandoff).not.toHaveBeenCalled();
}

describe("update.run handoff refusal diagnostics", () => {
  beforeEach(() => {
    detectSupervisor.mockReturnValueOnce("launchd");
    mockGlobalInstallSurface();
  });
  it.each(["managed-service-handoff-failed", "update-recovery-pending"])(
    "retains the helper's finalized refusal and handoff cause (%s)",
    async (reason) => {
      startHandoff.mockImplementationOnce(async (params) => {
        finishUpdateRun(expectDefined(params.runId, "handoff run"), {
          status: "failed",
          reason,
        });
        throw Object.assign(new Error("spawn node EACCES"), { code: "EACCES" });
      });
      const payload = expectDefined(await captureUpdateRunPayload(), "update response");
      const run = readRun(payload);
      expect(payload.result).toMatchObject({ status: "error", reason });
      expect(run).toMatchObject({ status: "failed", reason });
      expect(run.steps.flatMap((step) => step.failureFacts ?? [])).toContainEqual(
        expect.objectContaining({ code: "handoff-permission-denied" }),
      );
      const report = await failureReport(run);
      expect(report.body).toContain("handoff-permission-denied");
      expect(report.body).toContain("Recovery outcome: Gateway kept serving");
      expect(report.body).not.toContain("exit unknown");
    },
  );

  it("records a real detached helper refusal before launchd activation", async () => {
    const root = tempDirs.make("openclaw-handoff-missing-runtime-");
    const tmp = await import("../../infra/tmp-openclaw-dir.js");
    const coordinator = vi.spyOn(tmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(root);
    const handoff = await vi.importActual<
      typeof import("../../infra/update-managed-service-handoff.js")
    >("../../infra/update-managed-service-handoff.js");
    startHandoff.mockImplementationOnce((params) =>
      handoff.startManagedServiceUpdateHandoff({
        ...params,
        root,
        env: { ...process.env },
        execPath: process.execPath,
        argv1: path.join(root, "missing-entry.cjs"),
        supervisor: "launchd",
      }),
    );
    try {
      const payload = expectDefined(await captureUpdateRunPayload(), "update response");
      const run = readRun(payload);
      const report = await failureReport(run);
      expect(payload.ok).toBe(false);
      expect(report.body).toContain("handoff-helper-exited");
      expect(report.body).toContain(
        "Gateway kept serving; handoff failed before ownership transfer",
      );
      expect(report.body).not.toContain("exit unknown");
      expectServing();
    } finally {
      coordinator.mockRestore();
    }
  });

  it.each([
    ["helper-start-failed", Object.assign(new Error("spawn node EAGAIN"), { code: "EAGAIN" })],
    ["service-refused", new Error("launchctl bootstrap failed")],
    ["ownership-refused", new Error("managed update handoff helper lease identity is unavailable")],
    ["timeout", new Error("managed update handoff did not signal readiness within 1800 seconds")],
  ])("persists and publishes the closed handoff kind %s", async (kind, error) => {
    error.message +=
      " token=fixture-private-token /Users/fixture-private-user/private-install https://fixture-private-host.invalid/path";
    startHandoff.mockRejectedValueOnce(error);
    const payload = expectDefined(await captureUpdateRunPayload(), "update response");
    const run = readRun(payload);
    const fact = run.steps
      .flatMap((step) => step.failureFacts ?? [])
      .find((item) => item.code === `handoff-${kind}`);
    expect(fact).toMatchObject({ check: "managed-service", code: `handoff-${kind}` });
    expect(fact?.message).toContain("openclaw");
    expect(run.verification.rollbackOutcome).toMatchObject({ status: "not-needed" });
    const report = await failureReport(run, run.reason ?? undefined);
    expect(report.body).toContain(`Failing check managed-service (handoff-${kind})`);
    expect(report.body).toContain(
      "Recovery outcome: Gateway kept serving; handoff failed before ownership transfer",
    );
    expect(report.body).not.toContain("exit unknown");
    for (const privateValue of [
      "fixture-private-token",
      "fixture-private-user",
      "fixture-private-host",
      "private-install",
    ]) {
      expect(JSON.stringify(run.steps)).not.toContain(privateValue);
      expect(report.body).not.toContain(privateValue);
    }
    expectServing();
  });

  it("publishes a recovery action without restarting when the original Node is gone", async () => {
    startHandoff.mockRejectedValueOnce(
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
    expect(scheduleRestart).not.toHaveBeenCalled();
    expect(run?.origin.nextAction).toContain("openclaw gateway install --force");
    expect(run?.steps.flatMap((step) => step.failureFacts ?? [])).toContainEqual(
      expect.objectContaining({ code: "handoff-runtime-unavailable" }),
    );
    expect(renderUpdateRunReport(expectDefined(run, "update run")).markdown).toContain(
      "The serving Gateway has not been stopped.",
    );
  });

  it("preserves the Node engine refusal and serving observation for update.run", async () => {
    const message =
      "Node 26.10.0 at /fixture/node requires >=24.22.1 <25 || >=26.12.1. Install Node 24.22.1 and update the service definition selecting /fixture/node.";
    startHandoff.mockRejectedValueOnce(
      new UpdatePreMutationError("preflight-node-runtime-incompatible", message),
    );

    const payload = expectDefined(await captureUpdateRunPayload(), "update response");
    const run = readRun(payload);
    expect(payload).toMatchObject({
      ok: false,
      result: { status: "error", reason: "preflight-node-runtime-incompatible" },
    });
    expect(run.origin.nextAction).toBe(message);
    expect(run.verification.serviceRunning).toBe(true);
    expect(renderUpdateRunReport(run).lines.join("\n")).toContain(message);
    expectServing();
  });

  it.each(["helper-start", "sentinel-write"] as const)(
    "cancels its exact helper when admission ends during %s",
    async (boundary) => {
      let current = true;
      if (boundary === "helper-start") {
        const start = expectDefined(startHandoff.getMockImplementation(), "handoff fixture");
        startHandoff.mockImplementationOnce(async (params) => {
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
      const started = expectDefined(startHandoff.mock.calls[0]?.[0], "started handoff");
      expect(transferHandoff).not.toHaveBeenCalled();
      expect(cancelHandoff).toHaveBeenCalledExactlyOnceWith({
        kind: "managed-update-handoff",
        handoffId: started.handoffId,
        installRoot: "/tmp/openclaw-global",
      });
      expect(scheduleRestart).not.toHaveBeenCalled();
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
      if (failure === "sentinel-write") {
        sentinelState.restartSentinelWriteError = new Error("state database unavailable");
      } else if (failure === "transfer-rejected") {
        transferHandoff.mockResolvedValueOnce(false);
      } else {
        transferHandoff.mockRejectedValueOnce(new Error("EPIPE"));
      }
      cancelHandoff.mockImplementationOnce(async () => {
        const started = startHandoff.mock.calls[0]?.[0];
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

      const started = startHandoff.mock.calls[0]?.[0];
      expect(cancelHandoff).toHaveBeenCalledExactlyOnceWith({
        kind: "managed-update-handoff",
        handoffId: started?.handoffId,
        installRoot: "/tmp/openclaw-global",
      });
      expect(transferHandoff).toHaveBeenCalledTimes(failure === "sentinel-write" ? 0 : 1);
      expect(scheduleRestart).not.toHaveBeenCalled();
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
      const run = readRun(payload);
      const failureFacts = [errorFact(message)];
      const report = await failureReport(run, run.reason ?? undefined);
      if (failure === "sentinel-write") {
        expect(report.body).toContain("Recovery outcome: Gateway kept serving");
        expect(report.body).toContain("handoff-payload-failed");
        expect.soft(report.body).toContain("Failing check managed-service (Error)");
        expect.soft(report.body).not.toContain(message);
        expect.soft(report.body).toContain("[redacted-diagnostic]");
      } else {
        expect(report.body).not.toContain("Recovery outcome: Gateway kept serving");
        expect.soft(report.body).toContain(`Failed phase requested: ${message}`);
      }
      expect(run.steps).toContainEqual(
        expect.objectContaining({
          step: "requested",
          status: "failed",
          failureFacts: expect.arrayContaining(failureFacts),
        }),
      );
      expect(payload?.result).toMatchObject({
        steps: expect.arrayContaining([
          expect.objectContaining({ failureFacts: expect.arrayContaining(failureFacts) }),
        ]),
      });
      expect(sendNotice).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message:
            "⚠️ OpenClaw couldn't finish updating.\nFor details, open Settings → Updates in the Control UI or run `openclaw update status` in your terminal.",
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
  ])(
    "records a handoff refusal: $message",
    async ({ error, reason, message, publicMessage = message, statusMessage = message }) => {
      startHandoff.mockRejectedValueOnce(error);

      const payload = await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, () =>
        captureUpdateRunPayload(),
      );

      expect(scheduleRestart).not.toHaveBeenCalled();
      expect(payload?.ok).toBe(false);
      expect(payload?.result).toMatchObject({
        status: "error",
        reason,
      });
      expect(payload?.handoff).toBeUndefined();
      const run = readRun(payload);
      const report = await failureReport(run, reason);
      if (error instanceof UpdatePreMutationError) {
        expect(run.origin.nextAction).toBe(message);
        expect(renderUpdateRunReport(run).markdown).toContain(message);
        expect(report.body).not.toContain("sudo systemctl restart");
      }
      expect.soft(report.body).toContain(`Failed phase requested: ${publicMessage}`);
      expect.soft(report.body).not.toContain("exit unknown");
      const failureFacts =
        error instanceof UpdatePreMutationError ? error.failureFacts : [errorFact(message)];
      expect(run.steps).toContainEqual(
        expect.objectContaining({
          step: "requested",
          status: "failed",
          failureFacts: expect.arrayContaining(failureFacts),
        }),
      );
      expect(payload?.result).toMatchObject({
        steps: [expect.objectContaining({ failureFacts: expect.arrayContaining(failureFacts) })],
      });
      const sentinel = expectDefined(sentinelState.capturedPayload, "restart sentinel");
      expect(sentinel.stats?.steps).toContainEqual(
        expect.objectContaining({ failureFacts: expect.arrayContaining(failureFacts) }),
      );
      expect(formatUpdateRestartStatusValue(sentinel)).toContain(statusMessage);
      expect(await buildStatusUpdateRows(sentinel)).toContainEqual({
        Item: "Update run",
        Value: expect.stringContaining(statusMessage),
      });
    },
  );
});

describe("update.run foreground respawn admission", () => {
  const sessionKey = "agent:main:slack:dm:C0123ABC:thread:1234567890.123456";

  it.each(["before", "after"] as const)(
    "refuses foreground respawn disabled %s acknowledgement",
    async (timing) => {
      const acknowledged = timing === "after";
      await withEnvAsync({ OPENCLAW_NO_RESPAWN: acknowledged ? undefined : "1" }, async () => {
        if (acknowledged) {
          sendNotice.mockImplementationOnce(async () => {
            process.env.OPENCLAW_NO_RESPAWN = "1";
            return true;
          });
        }
        const response = await captureUpdateRunPayload({ sessionKey });
        expect(response).toMatchObject({
          ok: false,
          ackDelivered: acknowledged,
          result: { reason: "restart-unavailable" },
          message: expect.stringContaining("OPENCLAW_NO_RESPAWN"),
        });
        if (!acknowledged) {
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
          expect(sendNotice).not.toHaveBeenCalled();
        }
        expect(startHandoff).not.toHaveBeenCalled();
        expect(transferHandoff).not.toHaveBeenCalled();
        expect(scheduleRestart).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["before", "during"] as const)(
    "keeps serving when respawn is disabled %s the parking notification",
    async (timing) => {
      await withEnvAsync({ OPENCLAW_NO_RESPAWN: undefined }, async () => {
        expect(await captureUpdateRunPayload({ sessionKey })).toMatchObject({ ok: true });
        const handoff = expectDefined(startHandoff.mock.calls[0]?.[0], "prepared handoff");
        if (timing === "before") {
          process.env.OPENCLAW_NO_RESPAWN = "1";
        } else {
          sendNotice.mockImplementationOnce(async () => {
            process.env.OPENCLAW_NO_RESPAWN = "1";
            return true;
          });
        }

        await expect(expectDefined(handoff.beforePark, "parking callback")()).rejects.toThrow(
          "OPENCLAW_NO_RESPAWN",
        );
        expect(scheduleRestart).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["launchd", "systemd", null] as const)(
    "admits updates when supervisor=%s permits respawn",
    async (supervisor) => {
      detectSupervisor.mockReturnValue(supervisor);
      const response = await withEnvAsync({ OPENCLAW_NO_RESPAWN: supervisor ? "1" : "0" }, () =>
        captureUpdateRunPayload(),
      );
      expect(response).toMatchObject({ ok: true, handoff: { status: "started" } });
      expect(startHandoff).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ supervisor }));
      expect(transferHandoff).toHaveBeenCalledOnce();
    },
  );
});
