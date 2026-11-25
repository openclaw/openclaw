import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import {
  adoptUpdateCampaignMock,
  detectRespawnSupervisorMock,
  invokeUpdateRun,
  mockGlobalInstallSurface,
  startManagedServiceUpdateHandoffMock,
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

function expectWarning(warn: ReturnType<typeof vi.fn>, text: string) {
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(text));
}

describe("update.run unexpected-error diagnostics", () => {
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
});
