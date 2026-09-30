import { expect, it, vi } from "vitest";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  captureUpdateRunPayload,
  mockGlobalInstallSurface,
  scheduleGatewayRestartMock,
  startManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

const guidance = vi.hoisted(() => ({
  version: 1 as const,
  action: "update" as const,
  name: "Deployment manager",
  runFrom: "deployment host",
  command: "deployctl update gateway",
}));
vi.mock("../../plugins/supervisor-guidance-runtime.js", () => ({
  resolveExternalSupervisorGuidance: vi.fn(async () => guidance),
}));

it("returns guidance on an external update refusal without persisting or executing it", async () => {
  mockGlobalInstallSurface();
  const payload = await withEnvAsync({ OPENCLAW_SUPERVISOR_MODE: "external" }, () =>
    captureUpdateRunPayload(),
  );
  expect(payload).toMatchObject({
    ok: false,
    externalSupervisorGuidance: guidance,
    result: { status: "skipped", reason: "external-supervisor-update-required" },
  });
  expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
  expect(payload?.runId).toEqual(expect.any(String));
  const run = getUpdateRun(payload!.runId);
  expect(run).toBeTruthy();
  expect(JSON.stringify(run)).not.toContain(guidance.command);
});
