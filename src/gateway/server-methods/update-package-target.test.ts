import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateCampaignController } from "../../infra/update-campaign.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  adoptUpdateCampaignMock,
  bindUpdateCampaignRunMock,
  cancelManagedServiceUpdateHandoffMock,
  captureUpdateRunPayload,
  clearUpdateCampaignMock,
  detectRespawnSupervisorMock,
  getUpdateAvailableMock,
  getUpdateCampaignStateMock,
  invokeUpdateRun,
  mockGlobalInstallSurface,
  normalizeUpdateChannelMock,
  resolveUpdateInstallSurfaceMock,
  scheduleGatewayRestartMock,
  sentinelState,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

const scheduler = createTestGatewayScheduler();
const campaign = new UpdateCampaignController(scheduler);
const target = { kind: "package", version: "2026.9.5" } as const;

beforeEach(() => {
  // Keep effect fixtures, but exercise real request and campaign admission.
  adoptUpdateCampaignMock.mockImplementation((expected) => campaign.adopt(expected));
  getUpdateCampaignStateMock.mockImplementation(() => campaign.getState());
  clearUpdateCampaignMock.mockImplementation(() => campaign.clear());
  bindUpdateCampaignRunMock.mockImplementation((id, runId) => campaign.bindRun(id, runId));
  mockGlobalInstallSurface();
  normalizeUpdateChannelMock.mockReturnValue("stable");
  detectRespawnSupervisorMock.mockReturnValue("schtasks");
});

afterEach(() => campaign.clear());
afterAll(() => scheduler.stop());

function expectNoUpdateEffect() {
  expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
  expect(sentinelState.capturedPayload).toBeUndefined();
}

function announce(version: string) {
  const apply = vi.fn(async () => "applied" as const);
  campaign.announce({
    target: { kind: "package", version },
    inspect: { getQueueSize: () => 1 },
    apply,
    onChange: vi.fn(),
  });
  return apply;
}

describe("update.run exact package target", () => {
  it.each(["stable", "beta"] as const)(
    "retains the requested version on %s when availability advances",
    async (channel) => {
      normalizeUpdateChannelMock.mockReturnValue(channel);
      getUpdateAvailableMock.mockReturnValue({
        currentVersion: "2026.8.2",
        latestVersion: "2026.9.6",
        channel,
      });
      const response = await captureUpdateRunPayload({ target });
      expect(response).toMatchObject({
        ok: true,
        handoff: { status: "started" },
        sentinel: { persisted: true },
      });
      expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          tag: target.version,
          meta: expect.objectContaining({ target: "version 2026.9.5" }),
        }),
      );
      expect(getUpdateRun(response!.runId)).toMatchObject({
        target: { kind: "package", version: target.version },
        status: "running",
      });
      expect(sentinelState.capturedPayload?.stats?.target).toBe("version 2026.9.5");
      expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    },
  );

  it("rejects a moving package tag through the real request validator", async () => {
    const respond = vi.fn();
    await invokeUpdateRun({ target: { ...target, version: "latest" } }, respond);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(adoptUpdateCampaignMock).not.toHaveBeenCalled();
    expectNoUpdateEffect();
  });

  it.each([
    { kind: "git", mode: "git" },
    { kind: "package-root", mode: "unknown" },
    { kind: "global", mode: "pnpm" },
    { kind: "global", mode: "bun" },
  ] as const)("rejects a $kind/$mode installation without update effects", async (surface) => {
    resolveUpdateInstallSurfaceMock
      .mockReset()
      .mockResolvedValue({ ...surface, root: "/tmp/openclaw", packageRoot: "/tmp/openclaw" });
    const response = await captureUpdateRunPayload({ target });
    expect(response).toMatchObject({ ok: false, result: { reason: "unsupported-update-target" } });
    expect(adoptUpdateCampaignMock).not.toHaveBeenCalled();
    expectNoUpdateEffect();
  });

  it.each([
    { channel: "dev", reason: "unsupported-update-target" },
    { channel: "extended-stable", reason: "extended-stable-tag-unsupported" },
  ] as const)("preserves the $channel owner's target policy", async ({ channel, reason }) => {
    normalizeUpdateChannelMock.mockReturnValue(channel);
    const response = await captureUpdateRunPayload({ target });
    expect(response).toMatchObject({ ok: false, result: { reason } });
    expect(adoptUpdateCampaignMock).not.toHaveBeenCalled();
    expectNoUpdateEffect();
  });

  it("leaves a mismatching campaign untouched and then adopts only its exact version", async () => {
    const apply = announce("2026.9.6");
    const before = campaign.getState();
    const rejected = await captureUpdateRunPayload({ target });
    expect(rejected).toMatchObject({
      ok: false,
      result: { reason: "update-target-campaign-mismatch" },
    });
    expect(campaign.getState()).toEqual(before);
    expectNoUpdateEffect();

    mockGlobalInstallSurface();
    const accepted = await captureUpdateRunPayload({ target: { ...target, version: "2026.9.6" } });
    expect(accepted?.ok).toBe(true);
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ tag: "2026.9.6" }),
    );
    expect(campaign.getState()?.state).toBe("applying");
    expect(campaign.getRunId()).toBe(accepted?.runId);
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not start a second update while a matching campaign is applying", async () => {
    announce(target.version);
    const first = await captureUpdateRunPayload({ target });
    mockGlobalInstallSurface();
    const second = await captureUpdateRunPayload({ target });
    expect(first?.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, result: { reason: "update-campaign-applying" } });
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    expect(getUpdateRun(first!.runId)?.target?.version).toBe(target.version);
  });

  it("retains the target and cancels handoff when durable acknowledgement cannot be saved", async () => {
    sentinelState.restartSentinelWriteError = new Error("disk full");
    const response = await captureUpdateRunPayload({ target });
    expect(response?.ok).toBe(false);
    expect(getUpdateRun(response!.runId)).toMatchObject({
      status: "failed",
      target: { kind: "package", version: target.version },
    });
    expect(cancelManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  });
});
