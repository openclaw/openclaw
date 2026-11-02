// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { createUpdateRunFixture as updateRunFixture } from "../test-helpers/update-run.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { flushMicrotasks, type RequestFn } from "./overlays-access.test-support.ts";
import { AUTO_UPDATE_SCHEDULE } from "./overlays-update-campaign.test-support.ts";
import {
  automaticSchedule,
  campaignSchedule as campaign,
  disposeTestOverlays,
  automaticTest,
  gatewayTest,
  settleAtCleanup,
  pendingReply,
  updateHello,
  updateStatusRequest,
  updateSentinel,
  methodRequest,
  requestCalls,
} from "./overlays-update.test-support.ts";

afterEach(async () => {
  await disposeTestOverlays();
  vi.useRealTimers();
});

describe("application update campaign overlays", () => {
  it("retires only the applying campaign owned by a finished run", async () => {
    const run = updateRunFixture({
      status: "failed",
      phase: "finished",
      origin: { campaignId: AUTO_UPDATE_SCHEDULE.campaign.id },
    });
    const { harness, overlays } = automaticTest(async () => ({ lastRun: run }));
    await waitForFast(() => expect(overlays.snapshot.updateRun).toEqual(run));
    harness.emitEvent("update.available", { schedule: automaticSchedule({ state: "applying" }) });
    expect(overlays.snapshot.updateRun).toEqual(run);
    expect(overlays.snapshot.updateRunning).toBe(false);
  });

  it("reads the recorded outcome when an automatic campaign ends between polls", async () => {
    vi.useFakeTimers();
    const request = updateStatusRequest(() => ({
      sentinel: updateSentinel("build-failed", 62_000, { mode: "git" }),
      schedule: { channel: "stable", autoEnabled: true },
    }));
    const { harness, overlays, expectState } = automaticTest(request);
    harness.emitEvent("update.available", {
      schedule: automaticSchedule({ state: "applying", updatedAtMs: 61_000 }),
    });
    harness.emitEvent("update.available", { schedule: { channel: "stable", autoEnabled: true } });
    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();

    expectState({
      updateStatusBanner: { text: expect.stringContaining("build-failed") },
      recordedUpdateAttempt: { timestampMs: 62_000, status: "error", reason: "build-failed" },
    });
    expect(overlays.snapshot.updateSchedule?.campaign).toBeUndefined();
    const statusRequests = requestCalls(request, "update.status");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requestCalls(request, "update.status")).toHaveLength(statusRequests.length);
  });

  it.each(["disconnect", "dispose"])(
    "does not restart an in-flight campaign poll after %s",
    async (boundary) => {
      vi.useFakeTimers();
      const updateStatus = pendingReply({});
      const request = methodRequest("update.status", () => updateStatus.promise);
      const { harness, overlays } = automaticTest(request);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(requestCalls(request, "update.status")).toHaveLength(2);
      if (boundary === "disconnect") {
        harness.update({ phase: "reconnecting" });
      } else {
        overlays.dispose();
      }
      updateStatus.resolve({ schedule: AUTO_UPDATE_SCHEDULE });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(requestCalls(request, "update.status")).toHaveLength(2);
    },
  );

  it("keeps a manual status check's error visible when campaign polling becomes due", async () => {
    vi.useFakeTimers();
    const manualStatus = pendingReply({});
    const request = updateStatusRequest((checkout) =>
      checkout ? manualStatus.promise : Promise.resolve({ schedule: AUTO_UPDATE_SCHEDULE }),
    );
    const { overlays } = automaticTest(request);
    const refresh = overlays.refreshUpdateStatus();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(overlays.snapshot.updateStatusRefreshing).toBe(true);

    manualStatus.reject(new Error("manual status unavailable"));
    expect(await refresh).toBe(false);

    expect(overlays.snapshot.updateStatusRefreshing).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(overlays.snapshot.updateStatusCheckBanner?.text).toContain("manual status unavailable");
  });

  it.each([false, true])(
    "discards an explicit refresh after administrator access is revoked (restored: %s)",
    async (restoreAdmin) => {
      const updateStatus = pendingReply({});
      let statusReads = 0;
      const request = updateStatusRequest((checkout) => {
        if (checkout) {
          return updateStatus.promise;
        }
        statusReads += 1;
        return statusReads === 1
          ? Promise.resolve({ sentinel: updateSentinel("retained-admin-only-attempt", 500) })
          : Promise.resolve({});
      });
      const { harness, overlays, expectState } = automaticTest(request);
      await flushMicrotasks();
      expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("retained-admin-only-attempt");
      const refresh = overlays.refreshUpdateStatus();
      harness.update({ hello: updateHello(AUTO_UPDATE_SCHEDULE, "operator.read") });
      expectState({ updateStatusBanner: null, recordedUpdateAttempt: null });
      if (restoreAdmin) {
        harness.update({ hello: updateHello(AUTO_UPDATE_SCHEDULE) });
      }
      updateStatus.resolve({ sentinel: updateSentinel("admin-only-attempt", 62_000) });
      expect(await refresh).toBe(false);

      expectState({
        updateStatusBanner: null,
        recordedUpdateAttempt: null,
        updateStatusRefreshing: false,
      });
    },
  );

  it("refreshes an explicit dev checkout comparison on demand", async () => {
    const request = updateStatusRequest(() => ({
      sentinel: null,
      updateAvailable: null,
      schedule: {
        channel: "dev",
        autoEnabled: false,
        install: { kind: "git", git: { status: "behind", commitsBehind: 12 } },
      },
    }));
    const { overlays } = gatewayTest(request, updateHello({ channel: "dev", autoEnabled: false }));

    await overlays.refreshUpdateStatus();

    expect(request).toHaveBeenCalledWith(
      "update.status",
      { refreshCheckout: true },
      { timeoutMs: null },
    );
    expect(request).toHaveBeenCalledWith("update.status", {}, { timeoutMs: 5_000 });
    expect(overlays.snapshot.updateSchedule?.install?.git).toEqual({
      status: "behind",
      commitsBehind: 12,
    });
  });

  it("preserves the last update failure when a subsequent status check fails", async () => {
    const run = updateRunFixture({ status: "failed", phase: "finished", reason: "build-failed" });
    const request = vi.fn<RequestFn>(async () => ({ lastRun: run }));
    const { overlays } = gatewayTest(request);
    await overlays.refreshUpdateStatus();
    const failure = overlays.snapshot.updateStatusBanner;
    expect(failure?.tone).toBe("danger");
    request.mockRejectedValue(new Error("status unavailable"));
    await overlays.refreshUpdateStatus();
    expect(overlays.snapshot.updateRun).toEqual(run);
    expect(overlays.snapshot.updateStatusBanner).toEqual(failure);
    expect(overlays.snapshot.updateStatusCheckBanner?.tone).toBe("warn");
    request.mockResolvedValue({ lastRun: run });
    await overlays.refreshUpdateStatus();
    expect(overlays.snapshot.updateStatusCheckBanner).toBeNull();
    expect(overlays.snapshot.updateStatusBanner).toEqual(failure);
  });

  it("polls update.status only for administrators with an active campaign", async () => {
    vi.useFakeTimers();
    let statusReads = 0;
    const request = updateStatusRequest(() =>
      ++statusReads === 1
        ? { schedule: AUTO_UPDATE_SCHEDULE }
        : {
            sentinel: updateSentinel("build-failed"),
            updateAvailable: {
              currentVersion: "1.0.0",
              latestVersion: "2.0.0",
              channel: "stable",
            },
            schedule: {
              channel: "stable",
              autoEnabled: true,
              target: { kind: "package", version: "2.0.0" },
            },
          },
    );
    const { harness, overlays, expectState } = gatewayTest(
      request,
      updateHello(
        campaign(
          { applyAtMs: 62_000, updatedAtMs: 2_000 },
          { channel: "stable", target: { kind: "package", version: "2.0.0" } },
        ),
      ),
    );

    await vi.advanceTimersByTimeAsync(4_000);
    harness.update({ sessionKey: "agent:main:active" });
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(requestCalls(request, "update.status")).toHaveLength(2);
    expectState({
      updateStatusBanner: { text: expect.stringContaining("build-failed") },
    });
    expect(overlays.snapshot.updateSchedule?.campaign).toBeUndefined();

    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();
    expect(requestCalls(request, "update.status")).toHaveLength(2);

    harness.update({
      hello: updateHello(
        campaign({
          id: "campaign-2",
          state: "waiting-for-idle",
          announcedAtMs: 20_000,
          forceAtMs: 920_000,
          updatedAtMs: 20_000,
        }),
        "operator.read",
      ),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();
    expect(requestCalls(request, "update.status")).toHaveLength(2);
    expectState({
      updateCampaignStatusHydrated: false,
      updateSchedule: { campaign: { id: "campaign-2" } },
    });
  });

  it("holds a campaign surface until its first authoritative status arrives", async () => {
    vi.useFakeTimers();
    const updateStatus = deferred<unknown>();
    const request = methodRequest("update.status", () => updateStatus.promise);
    const { overlays, expectState } = gatewayTest(
      request,
      updateHello(
        campaign({ id: "campaign-blocked", state: "waiting-for-idle" }, { channel: "dev" }),
      ),
    );

    expect(overlays.snapshot.updateCampaignStatusHydrated).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestCalls(request, "update.status")).toHaveLength(2);
    expect(overlays.snapshot.updateCampaignStatusHydrated).toBe(false);

    updateStatus.resolve({ sentinel: updateSentinel("build-dirty") });
    await flushMicrotasks();

    expectState({
      updateCampaignStatusHydrated: true,
      updateStatusBanner: { text: expect.stringContaining("build-dirty") },
    });
  });

  it("holds an active campaign and adopts the returned schedule", async () => {
    const request = methodRequest("update.hold", () => ({
      ok: true,
      schedule: campaign(
        { state: "waiting-for-idle", holdUntilMs: 3_601_000, forceAtMs: 4_501_000 },
        { channel: "stable", target: { kind: "package", version: "2.0.0" } },
      ),
    }));
    const { harness, overlays, expectState } = gatewayTest(
      request,
      updateHello(
        campaign(
          { applyAtMs: 61_000 },
          { channel: "stable", target: { kind: "package", version: "2.0.0" } },
        ),
      ),
    );

    await expect(overlays.holdUpdate()).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("update.hold", {});
    expectState({
      updateSchedule: { campaign: { state: "waiting-for-idle", holdUntilMs: 3_601_000 } },
      heldUpdateCampaignId: "campaign-1",
    });

    harness.emitEvent("update.available", {
      updateAvailable: null,
      schedule: { channel: "stable", autoEnabled: true },
    });
    await expect(overlays.holdUpdate()).resolves.toBe(false);
    expect(requestCalls(request, "update.hold")).toHaveLength(1);
  });

  it.each([
    { boundary: "applying", reply: "success" },
    { boundary: "applying", reply: "error" },
    { boundary: "revoked", reply: "success" },
    { boundary: "revoked", reply: "error" },
  ])("does not publish a stale hold $reply after $boundary", async ({ boundary, reply }) => {
    const holdReply = pendingReply({});
    const request = methodRequest("update.hold", () => holdReply.promise);
    const { harness, overlays, expectState } = automaticTest(request);
    const holding = settleAtCleanup(overlays.holdUpdate());
    if (boundary === "applying") {
      harness.emitEvent("update.available", {
        schedule: automaticSchedule({ state: "applying", updatedAtMs: 61_000 }),
      });
    } else {
      harness.update({ hello: updateHello(AUTO_UPDATE_SCHEDULE, "operator.read") });
    }
    if (reply === "success") {
      holdReply.resolve({ ok: true, schedule: automaticSchedule({ holdUntilMs: 3_601_000 }) });
    } else {
      holdReply.reject(new Error("retired hold response"));
    }
    await expect(holding).resolves.toBe(boundary === "applying" && reply === "success");

    expectState({
      updateRunning: boundary === "applying",
      updateSchedule: { campaign: { state: boundary === "applying" ? "applying" : "countdown" } },
      heldUpdateCampaignId: null,
      updateStatusBanner: null,
    });
  });

  it("adopts an authoritative held schedule when update.hold returns false", async () => {
    const request = vi.fn<RequestFn>(async () => ({
      ok: false,
      schedule: campaign(
        { state: "waiting-for-idle", holdUntilMs: 3_601_000, forceAtMs: 4_501_000 },
        { channel: "dev" },
      ),
    }));
    const { overlays, expectState } = gatewayTest(
      request,
      updateHello(campaign({ applyAtMs: 61_000 }, { channel: "dev" })),
    );

    await expect(overlays.holdUpdate()).resolves.toBe(false);
    expectState({
      updateSchedule: { campaign: { state: "waiting-for-idle", holdUntilMs: 3_601_000 } },
      heldUpdateCampaignId: "campaign-1",
    });
  });

  it("does not hold while an update run or its reconciliation is pending", async () => {
    const updateRun = deferred<unknown>();
    const request = vi.fn<RequestFn>((method) =>
      method === "update.run"
        ? updateRun.promise
        : Promise.resolve(
            method === "update.runs.get" ? { run: updateRunFixture() } : { ok: true },
          ),
    );
    const { overlays } = gatewayTest(request, updateHello(campaign({ state: "waiting-for-idle" })));

    const running = overlays.runUpdate();
    await flushMicrotasks();
    expect(overlays.snapshot.updateRunning).toBe(true);
    await expect(overlays.holdUpdate()).resolves.toBe(false);

    updateRun.resolve({ ok: true, runId: updateRunFixture().runId });
    await running;
    expect(overlays.snapshot.updateRunning).toBe(true);
    await expect(overlays.holdUpdate()).resolves.toBe(false);
    expect(requestCalls(request, "update.hold")).toHaveLength(0);
  });
});
