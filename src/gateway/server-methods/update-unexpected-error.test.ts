import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import {
  adoptUpdateCampaignMock,
  cancelManagedServiceUpdateHandoffMock,
  invokeUpdateRun,
  resolveUpdateInstallSurfaceMock,
  resolveStartupInstallStatusMock,
  scheduleGatewayRestartMock,
  sentinelState,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

describe("update.run unexpected-error diagnostics", () => {
  it("keeps the primary exception when optional history reads fail", async () => {
    const original = Object.assign(new TypeError("campaign admission failed"), { code: "EACCES" });
    adoptUpdateCampaignMock.mockImplementationOnce(() => {
      throw original;
    });
    const historyRead = vi
      .spyOn(await import("../../infra/update-run-ledger.js"), "getUpdateRun")
      .mockImplementation(() => {
        throw new Error("history lookup failed");
      });
    const logGateway = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    let payload: { runId: string; result: UpdateRunResult } | undefined;
    try {
      await invokeUpdateRun(
        {},
        (_ok, response) => {
          payload = response as typeof payload;
        },
        undefined,
        { logGateway },
      );
    } finally {
      historyRead.mockRestore();
    }
    const response = expectDefined(payload, "update response");
    expect(response.result).toMatchObject({
      status: "error",
      reason: "unexpected-error",
      steps: [
        expect.objectContaining({
          failureFacts: [expect.objectContaining({ code: "EACCES", errorName: "TypeError" })],
        }),
      ],
    });
    expect(JSON.stringify(response.result)).not.toContain("history lookup failed");
    expect(getUpdateRun(response.runId)?.status).toBe("failed");
    expect(logGateway.warn).toHaveBeenCalledWith(
      expect.stringContaining("Update history could not be read"),
    );
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  });

  it.each(["none", "state", "diagnostics"] as const)(
    "preserves structured transfer failures and cancellation when recording fails=%s",
    async (recordingFailure) => {
      const error = Object.assign(
        new TypeError("handoff pipe failed", {
          cause: Object.assign(
            new Error(
              "Connection refused token=synthetic-secret host=private-host.example at /Users/example/private-file",
            ),
            { code: "ECONNREFUSED" },
          ),
        }),
        { code: "EACCES" },
      );
      error.stack = `TypeError: handoff pipe failed\n    at transfer (${path.resolve("src/infra/update-managed-service-handoff.ts")}:42:7)`;
      let restoreDiagnosticFailure: (() => void) | undefined;
      transferManagedServiceUpdateHandoffMock.mockImplementationOnce(async () => {
        if (recordingFailure !== "none") {
          const codec = await import("../../infra/update-run-codec.js");
          const encode = codec.encodeRun;
          const write = vi.spyOn(codec, "encodeRun").mockImplementation((record, options) => {
            const step = record.steps.find((entry) => entry.step === "requested");
            if (
              recordingFailure === "state" ? step?.status === "failed" : step?.failureFacts?.length
            ) {
              write.mockRestore();
              throw new Error("diagnostic ledger is read-only");
            }
            return encode(record, options);
          });
          restoreDiagnosticFailure = () => write.mockRestore();
        }
        throw error;
      });
      const logGateway = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
      let payload: { runId: string; ok: boolean; result: UpdateRunResult } | undefined;
      try {
        await invokeUpdateRun(
          {},
          (_ok, response) => {
            payload = response as typeof payload;
          },
          undefined,
          { logGateway },
        );
      } finally {
        restoreDiagnosticFailure?.();
      }
      const response = expectDefined(payload, "update response");
      expect(response).toMatchObject({
        ok: false,
        result: { status: "error", reason: "managed-service-handoff-failed" },
      });
      expect(response.result.steps).toContainEqual(
        expect.objectContaining({
          failureFacts: [
            expect.objectContaining({
              code: "EACCES",
              errorName: "TypeError",
              location: "src/infra/update-managed-service-handoff.ts:42:7",
              message: expect.stringContaining("Connection refused"),
            }),
          ],
        }),
      );
      expect(cancelManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
      expect(getUpdateRun(response.runId)?.status).toBe("failed");
      const report = await prepareUpdateFailureReport({
        attemptId: response.runId,
        result: response.result,
        recordedRun: getUpdateRun(response.runId),
      });
      expect(report.body).toContain("EACCES");
      expect(report.body).toContain("ECONNREFUSED");
      for (const privateText of [
        "synthetic-secret",
        "private-host.example",
        "/Users/example",
        "diagnostic ledger is read-only",
      ]) {
        expect(JSON.stringify(response.result)).not.toContain(privateText);
        expect(report.body).not.toContain(privateText);
      }
      if (recordingFailure !== "none") {
        expect(logGateway.warn).toHaveBeenCalledWith(
          expect.stringContaining(
            recordingFailure === "state"
              ? "Update failure state could not be recorded"
              : "Update diagnostics could not be recorded",
          ),
        );
      }
    },
  );

  it.each(["discovery", "installation ownership", "campaign adoption"])(
    "retains the requested target and redacted failure facts when %s throws",
    async (source) => {
      const error = Object.assign(
        new Error(
          "EACCES: permission denied, open '/Users/example/private-file' token=synthetic-secret\nprivate second line",
        ),
        { code: "EACCES" },
      );
      const root = "/tmp/openclaw-source";
      if (source === "discovery") {
        resolveStartupInstallStatusMock.mockRejectedValueOnce(error);
      } else {
        resolveStartupInstallStatusMock.mockResolvedValueOnce({
          root,
          status: {
            root,
            installKind: "git",
            packageManager: "pnpm",
            git: {
              root,
              sha: "b".repeat(40),
              tag: null,
              branch: "main",
              upstream: "origin/main",
              dirty: false,
              ahead: 0,
              behind: 1,
              fetchOk: true,
            },
          },
          installReceipt: null,
        });
        if (source === "installation ownership") {
          resolveUpdateInstallSurfaceMock.mockRejectedValueOnce(error);
        } else {
          adoptUpdateCampaignMock.mockImplementationOnce(() => {
            throw error;
          });
        }
      }
      const logGateway = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
      let payload:
        | { runId: string; ok: boolean; ackDelivered: boolean; result: UpdateRunResult }
        | undefined;
      await invokeUpdateRun(
        { target: { kind: "git", upstreamRef: "origin/main", upstreamSha: "a".repeat(40) } },
        (_ok, response) => {
          payload = response as typeof payload;
        },
        undefined,
        { logGateway },
      );

      const response = expectDefined(payload, "update response");
      const recordedRun = expectDefined(getUpdateRun(response.runId), "recorded update run");
      expect(response).toMatchObject({ ok: false, ackDelivered: false });
      expect(recordedRun).toMatchObject({
        status: "failed",
        phase: "finished",
        reason: "unexpected-error",
      });
      expect(recordedRun.target).toMatchObject({
        kind: "git",
        sha: "a".repeat(40),
      });
      const phase = source === "campaign adoption" ? "requested" : "installation-inspection";
      const failureFacts = [
        expect.objectContaining({
          check: phase,
          code: "EACCES",
          errorName: "Error",
          message: expect.stringContaining("EACCES: permission denied, open [redacted-path]"),
        }),
      ];
      expect(recordedRun.steps).toContainEqual(
        expect.objectContaining({
          step: phase,
          status: "failed",
          failureFacts,
        }),
      );
      expect(response.result).toMatchObject({
        status: "error",
        mode: "git",
        reason: "unexpected-error",
        before: { version: "1.0.0" },
        steps: [expect.objectContaining({ name: phase, exitCode: 1, failureFacts })],
      });
      expect(response.result.root).toBe(source === "campaign adoption" ? root : undefined);
      expect(adoptUpdateCampaignMock).toHaveBeenCalledTimes(source === "campaign adoption" ? 1 : 0);
      expect(response.result.recovery).toBeUndefined();
      expect(sentinelState.capturedPayload).toBeUndefined();
      expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(cancelManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
      const report = await prepareUpdateFailureReport({
        attemptId: response.runId,
        result: response.result,
        recordedRun,
      });
      expect(report.body).toContain(`Update target: ${"a".repeat(40)}`);
      expect(report.body).toContain("Update mode: git");
      expect(report.body).toContain(`Failed phase ${phase}:`);
      expect(report.body).toContain("EACCES; Permission denied");
      expect(report.body).toContain("Rollback outcome: not attempted");
      expect(report.body).toContain("Gateway RPC does not perform rollback");
      if (source !== "discovery") {
        expect(report.body).toContain("Installation method: git-checkout");
      }
      for (const privateText of [
        "/Users/example",
        "private-file",
        "synthetic-secret",
        "private second line",
      ]) {
        expect(JSON.stringify(response.result)).not.toContain(privateText);
        expect(JSON.stringify(recordedRun)).not.toContain(privateText);
        expect(report.body).not.toContain(privateText);
      }
      expect(logGateway.warn).toHaveBeenCalledOnce();
      expect(logGateway.warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    },
  );
});
