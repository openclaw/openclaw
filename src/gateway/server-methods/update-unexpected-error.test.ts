import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import {
  adoptUpdateCampaignMock,
  cancelManagedServiceUpdateHandoffMock,
  captureUpdateRunPayload,
  detectRespawnSupervisorMock,
  invokeUpdateRun,
  mockGlobalInstallSurface,
  resolveUpdateInstallSurfaceMock,
  resolveStartupInstallStatusMock,
  scheduleGatewayRestartMock,
  sentinelState,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

async function captureLoggedUpdate(params: Record<string, unknown> = {}) {
  const logGateway = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  let payload:
    | { runId: string; ok: boolean; ackDelivered: boolean; result: UpdateRunResult }
    | undefined;
  await invokeUpdateRun(
    params,
    (_ok, response) => {
      payload = response as typeof payload;
    },
    undefined,
    { logGateway },
  );
  return { response: expectDefined(payload, "update response"), logGateway };
}

function failureReport(response: { runId: string; result: UpdateRunResult }) {
  return prepareUpdateFailureReport({
    attemptId: response.runId,
    result: response.result,
    recordedRun: getUpdateRun(response.runId),
  });
}

function expectRedacted(values: unknown[], privateTexts: string[]) {
  for (const value of values) {
    for (const privateText of privateTexts) {
      expect(typeof value === "string" ? value : JSON.stringify(value)).not.toContain(privateText);
    }
  }
}

function expectWarning(warn: ReturnType<typeof vi.fn>, text: string) {
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(text));
}

describe("update.run unexpected-error diagnostics", () => {
  it("refuses exhausted Git discovery before adopting a campaign", async () => {
    const root = "/tmp/openclaw-source";
    resolveStartupInstallStatusMock.mockResolvedValueOnce({
      root,
      installReceipt: null,
      status: {
        root,
        installKind: "git",
        packageManager: "pnpm",
        error: {
          status: "failed",
          message: "Git update facts unavailable after two probes",
          timeoutMs: 45_000,
        },
      },
    });
    const payload = await captureUpdateRunPayload();
    expect(payload?.result).toMatchObject({ status: "error", reason: "unexpected-error" });
    expect(adoptUpdateCampaignMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  });

  it("logs a terminal failure at warning level with its public reason", async () => {
    mockGlobalInstallSurface();
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    startManagedServiceUpdateHandoffMock.mockRejectedValueOnce(
      new Error("synthetic helper launch failure"),
    );
    const { response, logGateway } = await captureLoggedUpdate();
    expect(response.result).toMatchObject({
      status: "error",
      reason: "managed-service-handoff-failed",
    });
    expectWarning(
      logGateway.warn,
      `status=error reason=managed-service-handoff-failed error="Error code=Error"`,
    );
    expect(logGateway.info).not.toHaveBeenCalledWith(
      expect.stringContaining("update.run completed"),
    );
  });

  it("keeps the primary exception when optional history reads fail", async () => {
    const original = Object.assign(new TypeError("campaign admission failed"), { code: "EACCES" });
    adoptUpdateCampaignMock.mockImplementationOnce(() => {
      throw original;
    });
    const historyRead = vi
      .spyOn(await import("../../infra/update-run-reader.js"), "getUpdateRunAsync")
      .mockImplementation(() => {
        throw new Error("history lookup failed");
      });
    const { response, logGateway } = await captureLoggedUpdate().finally(() => {
      historyRead.mockRestore();
    });
    expect(response.result).toMatchObject({
      status: "error",
      reason: "unexpected-error",
      steps: [{ failureFacts: [{ code: "EACCES", errorName: "TypeError" }] }],
    });
    expect(JSON.stringify(response.result)).not.toContain("history lookup failed");
    expect(getUpdateRun(response.runId)?.status).toBe("failed");
    expectWarning(logGateway.warn, "Update history could not be read");
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  });

  it.each(["none", "state", "diagnostics"] as const)(
    "preserves structured transfer failures and cancellation when recording fails=%s",
    async (recordingFailure) => {
      const cause = Object.assign(
        new Error(
          "Connection refused token=synthetic-secret host=private-host.example at /Users/example/private-file",
        ),
        { code: "ECONNREFUSED" },
      );
      const error = Object.assign(new TypeError("handoff pipe failed", { cause }), {
        code: "EACCES",
      });
      error.stack = `TypeError: handoff pipe failed\n    at transfer (${path.resolve("src/infra/update-managed-service-handoff.ts")}:42:7)`;
      let restoreDiagnosticFailure: (() => void) | undefined;
      transferManagedServiceUpdateHandoffMock.mockImplementationOnce(async () => {
        if (recordingFailure !== "none") {
          const worker = await import("../../state/openclaw-state-worker-store.js");
          const run = worker.runOpenClawStateWorkerOperation;
          const write = vi
            .spyOn(worker, "runOpenClawStateWorkerOperation")
            .mockImplementation((context, operation, options) =>
              run(
                context,
                (scope) =>
                  operation({
                    execute: (command, executeOptions) => {
                      if (
                        command.type ===
                        `updateRuns.${recordingFailure === "state" ? "recordStep" : "recordDiagnostics"}`
                      ) {
                        write.mockRestore();
                        throw new Error("diagnostic ledger is read-only");
                      }
                      return scope.execute(command, executeOptions);
                    },
                  }),
                options,
              ),
            );
          restoreDiagnosticFailure = () => write.mockRestore();
        }
        throw error;
      });
      const { response, logGateway } = await captureLoggedUpdate().finally(() => {
        restoreDiagnosticFailure?.();
      });
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
            expect.objectContaining({ code: "handoff-permission-denied" }),
          ],
        }),
      );
      expect(cancelManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
      expect(getUpdateRun(response.runId)?.status).toBe("failed");
      const report = await failureReport(response);
      expect(report.body).toContain("EACCES");
      expect(report.body).toContain("ECONNREFUSED");
      expectRedacted(
        [response.result, report.body],
        [
          "synthetic-secret",
          "private-host.example",
          "/Users/example",
          "diagnostic ledger is read-only",
        ],
      );
      if (recordingFailure !== "none") {
        expectWarning(
          logGateway.warn,
          recordingFailure === "state"
            ? "Update failure state could not be recorded"
            : "Update diagnostics could not be recorded",
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
      const { response, logGateway } = await captureLoggedUpdate({
        target: { kind: "git", upstreamRef: "origin/main", upstreamSha: "a".repeat(40) },
      });
      const recordedRun = expectDefined(getUpdateRun(response.runId), "recorded update run");
      const phase = source === "campaign adoption" ? "requested" : "installation-inspection";
      const failureFacts = [
        expect.objectContaining({
          check: phase,
          code: "EACCES",
          errorName: "Error",
          message: expect.stringContaining("EACCES: permission denied, open [redacted-path]"),
        }),
      ];
      expect(recordedRun).toMatchObject({
        status: "failed",
        phase: "finished",
        reason: "unexpected-error",
        target: { kind: "git", sha: "a".repeat(40) },
        steps: expect.arrayContaining([
          expect.objectContaining({ step: phase, status: "failed", failureFacts }),
        ]),
      });
      expect(response).toMatchObject({
        ok: false,
        ackDelivered: false,
        result: {
          status: "error",
          mode: "git",
          reason: "unexpected-error",
          before: { version: "1.0.0" },
          steps: [{ name: phase, exitCode: 1, failureFacts }],
        },
      });
      expect(response.result.root).toBe(source === "campaign adoption" ? root : undefined);
      expect(response.result.recovery).toBeUndefined();
      expect(adoptUpdateCampaignMock).toHaveBeenCalledTimes(source === "campaign adoption" ? 1 : 0);
      expect(sentinelState.capturedPayload).toBeUndefined();
      expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(cancelManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
      const report = await failureReport(response);
      expect(report.body).toContain(`Update target: ${"a".repeat(40)}`);
      expect(report.body).toContain("Update mode: git");
      expect(report.body).toContain(`Failed phase ${phase}:`);
      expect(report.body).toContain("EACCES; Permission denied");
      expect(report.body).toContain("Rollback outcome: not attempted");
      expect(report.body).toContain("Gateway RPC does not perform rollback");
      if (source !== "discovery") {
        expect(report.body).toContain("Installation method: git-checkout");
      }
      expectRedacted(
        [response.result, recordedRun, report.body],
        ["/Users/example", "private-file", "synthetic-secret", "private second line"],
      );
      expect(logGateway.warn).toHaveBeenCalledTimes(2);
      expectWarning(logGateway.warn, "EACCES");
      expectWarning(
        logGateway.warn,
        `status=error reason=unexpected-error error="Error code=EACCES exitCode=1"`,
      );
    },
  );
});
