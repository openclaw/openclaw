import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import {
  invokeUpdateRun,
  initializeGatewayUpdateStatusMock,
  resolveUpdateInstallSurfaceMock,
  runGatewayUpdateMock,
  runPostCoreFinalizeAfterGatewayUpdateMock,
  scheduleGatewaySigusr1RestartMock,
  sentinelState,
} from "./update.test-harness.js";

describe("update.run unexpected-error diagnostics", () => {
  it.each([
    { status: "error", diagnostics: true, sentinelFailure: false },
    { status: "ok", diagnostics: true, sentinelFailure: false },
    { status: "ok", diagnostics: false, sentinelFailure: false },
    { status: "ok", diagnostics: false, sentinelFailure: true },
  ] as const)(
    "preserves the $status outcome when diagnostic writes fail (facts=$diagnostics, sentinel=$sentinelFailure)",
    async ({ status, diagnostics, sentinelFailure }) => {
      if (sentinelFailure) {
        sentinelState.restartSentinelWriteError = new Error("restart notice unavailable");
      }
      const result: UpdateRunResult = {
        status,
        mode: "git",
        reason: status === "error" ? "doctor-failed" : undefined,
        ...(diagnostics
          ? { recovery: { serviceRestartSafe: true as const, version: "1.0.0" } }
          : {}),
        steps: [],
        durationMs: 1,
      };
      let restoreRecording: (() => void) | undefined;
      runGatewayUpdateMock.mockImplementationOnce(async () => {
        const verificationOwner = await import("../../infra/update-run-verification.js");
        const original = verificationOwner.recordUpdateRunVerificationRecord;
        const record = vi.spyOn(verificationOwner, "recordUpdateRunVerificationRecord");
        record.mockImplementation((runId, verification, options) => {
          if (
            "recovery" in verification ||
            "rollbackOutcome" in verification ||
            Object.keys(verification).length === 0
          ) {
            record.mockRestore();
            throw Object.assign(new Error("diagnostic ledger is read-only"), {
              code: "SQLITE_READONLY",
            });
          }
          return original(runId, verification, options);
        });
        restoreRecording = () => record.mockRestore();
        return result;
      });
      const logGateway = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
      let payload: { runId: string; result: UpdateRunResult; ok: boolean } | undefined;
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
        restoreRecording?.();
      }
      const response = expectDefined(payload, "update response");
      expect(response).toMatchObject({
        ok: status === "ok",
        result: { status, reason: result.reason },
      });
      if (sentinelFailure) {
        expect(sentinelState.capturedPayload).toBeUndefined();
        expect(response).toMatchObject({ sentinel: { persisted: false } });
        expect(getUpdateRun(response.runId)?.steps).toContainEqual(
          expect.objectContaining({
            step: "restarting",
            status: "failed",
            failureFacts: [expect.objectContaining({ message: "restart notice unavailable" })],
          }),
        );
      } else {
        expect(sentinelState.capturedPayload).toMatchObject({
          status,
          stats: { reason: result.reason ?? null },
        });
      }
      expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(status === "ok" ? 1 : 0);
      expect(getUpdateRun(response.runId)).toMatchObject({
        status: status === "ok" && !sentinelFailure ? "running" : "failed",
      });
      if (diagnostics || sentinelFailure) {
        expect(logGateway.warn).toHaveBeenCalledWith(
          expect.stringContaining("Update diagnostics could not be recorded"),
        );
      } else {
        expect(logGateway.warn).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["runner", "finalization", "rollback", "history-read"])(
    "retains report facts when %s throws",
    async (source) => {
      const error = Object.assign(
        new Error(
          "EACCES: permission denied, open '/Users/example/private-file' host=private-host.example token=synthetic-secret\nprivate second line",
        ),
        { code: "EACCES" },
      );
      error.stack = `Error: synthetic failure\n    at probe (/opt/openclaw/node_modules/dependency/index.js:1:1)\n    at build (${path.resolve("src/infra/update-runner-git.ts")}:42:7)`;
      const recovery = { serviceRestartSafe: true as const, version: "1.0.0" };
      let restoreHistoryRead: (() => void) | undefined;
      runGatewayUpdateMock.mockImplementationOnce(async (opts) => {
        await opts?.beforeGitMutation?.({ sha: "a".repeat(40), version: "2.0.0" });
        const step = { name: "build", command: "pnpm build", index: 0, total: 1 };
        opts?.progress?.onStepStart?.(step);
        if (source === "rollback") {
          opts?.progress?.onRollbackOutcome?.({
            status: "failed",
            reason: "Rollback command failed",
          });
        }
        if (source === "history-read") {
          const historyRead = vi
            .spyOn(await import("../../infra/update-run-ledger.js"), "getUpdateRun")
            .mockImplementationOnce(() => {
              throw new Error("history lookup failed");
            });
          restoreHistoryRead = () => historyRead.mockRestore();
        }
        if (source !== "finalization") {
          throw error;
        }
        opts?.progress?.onStepComplete?.({ ...step, exitCode: 0, durationMs: 1 });
        return {
          status: "error",
          mode: "git",
          before: { version: "1.0.0" },
          after: { version: "2.0.0" },
          recovery,
          durationMs: 1,
          steps: [{ ...step, cwd: "", exitCode: 0, durationMs: 1 }],
        };
      });
      if (source === "finalization") {
        runPostCoreFinalizeAfterGatewayUpdateMock.mockRejectedValueOnce(error);
      }
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
        restoreHistoryRead?.();
      }

      const response = expectDefined(payload, "update response");
      const recordedRun = expectDefined(getUpdateRun(response.runId), "recorded update run");
      const report = await prepareUpdateFailureReport({
        attemptId: response.runId,
        result: response.result,
        recordedRun,
      });
      const phase =
        source === "finalization"
          ? "validating"
          : source === "history-read"
            ? "requested"
            : "build";
      expect(recordedRun.target).toMatchObject({
        kind: "git",
        sha: "a".repeat(40),
        version: "2.0.0",
        installationMethod: "git-checkout",
      });
      expect(recordedRun.verification.rollbackOutcome).toMatchObject({
        status: source === "rollback" ? "failed" : "not-attempted",
      });
      expect(recordedRun.steps).toContainEqual(
        expect.objectContaining({
          step: phase,
          status: "failed",
          failureFacts: [
            expect.objectContaining({
              check: phase,
              code: "EACCES",
              message: expect.stringContaining("EACCES: permission denied, open [redacted-path]"),
            }),
          ],
        }),
      );
      expect(response.result).toMatchObject({
        status: "error",
        mode: "git",
        reason: "unexpected-error",
      });
      if (source === "finalization") {
        expect(response.result.recovery).toEqual(recovery);
        expect(sentinelState.capturedPayload?.stats?.recovery).toEqual(recovery);
        expect(response.result.steps).toContainEqual(
          expect.objectContaining({ name: "build", exitCode: 0 }),
        );
      }
      expect(report.body).toContain(`Update target: ${"a".repeat(40)}`);
      expect(report.body).toContain("Update mode: git");
      expect(report.body).toContain(`Failed phase ${phase}:`);
      expect(report.body).toContain("EACCES; Permission denied");
      expect(report.body).toContain("Gateway RPC");
      expect(report.body).toContain("git-checkout");
      expect(report.body).toContain("update-runner-git.ts:42:7");
      expect(report.body).toContain(
        source === "finalization"
          ? "Recovery outcome: verified safe to restart"
          : source === "rollback"
            ? "Rollback command failed"
            : "Gateway RPC does not perform rollback after an unexpected exception",
      );
      for (const privateText of [
        "/Users/example",
        "private-file",
        "synthetic-secret",
        "private-host.example",
        "private second line",
      ]) {
        expect(JSON.stringify(recordedRun)).not.toContain(privateText);
        expect(report.body).not.toContain(privateText);
      }
      expect(logGateway.warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
      if (source === "history-read") {
        expect(logGateway.warn).toHaveBeenCalledWith(
          expect.stringContaining("Update history could not be read"),
        );
        expect(report.body).not.toContain("history lookup failed");
      }
    },
  );

  it.each(["status", "owner"])(
    "records the installation resolution step when %s throws",
    async (source) => {
      const error = new TypeError(
        "installation inspection failed token=synthetic-secret host=private-host.example",
      );
      if (source === "status") {
        initializeGatewayUpdateStatusMock.mockRejectedValueOnce(error);
      } else {
        resolveUpdateInstallSurfaceMock.mockRejectedValueOnce(error);
      }
      let payload: { runId: string; result: UpdateRunResult } | undefined;
      await invokeUpdateRun({}, (_ok, response) => {
        payload = response as typeof payload;
      });
      const response = expectDefined(payload, "update response");
      const run = expectDefined(getUpdateRun(response.runId), "recorded update run");
      expect(run.target.kind).toBe(source === "status" ? undefined : "git");
      const report = await prepareUpdateFailureReport({
        attemptId: response.runId,
        result: response.result,
        recordedRun: run,
      });
      expect(report.body).toContain("installation-inspection");
      expect(report.body).toContain("TypeError");
      expect(report.body).toContain("installation inspection failed");
      expect(report.body).toContain(source === "status" ? "mode: unknown" : "Update mode: git");
      expect(report.body).not.toContain("synthetic-secret");
      expect(report.body).not.toContain("private-host.example");
      expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    },
  );
});
