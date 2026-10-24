// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdateRunFixture as updateRunFixture } from "../test-helpers/update-run.ts";
import { flushMicrotasks } from "./overlays-access.test-support.ts";
import { AUTO_UPDATE_SCHEDULE } from "./overlays-update-campaign.test-support.ts";
import {
  automaticSchedule,
  disposeTestOverlays,
  gatewayTest,
  automaticTest,
  pendingReply,
  updateHello,
  updateStatusRequest,
  updateSentinel,
} from "./overlays-update.test-support.ts";
import * as updateHelpers from "./update-overlay-helpers.ts";

afterEach(async () => {
  await disposeTestOverlays();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("application update status response ownership", () => {
  it("keeps newer status when an older response is still formatting its failure", async () => {
    const formatting = pendingReply<updateHelpers.UpdateFailureTriage | null>(null);
    const formattingStarted = pendingReply<void>(undefined);
    const older = updateRunFixture({ status: "failed" });
    const newer = updateRunFixture({
      runId: "newer-run",
      createdAtMs: 3,
      updatedAtMs: 4,
      status: "succeeded",
    });
    const originalProject = updateHelpers.projectUpdateRunFailure;
    vi.spyOn(updateHelpers, "projectUpdateRunFailure").mockImplementation((run) => {
      if (run === older) {
        formattingStarted.resolve();
        return formatting.promise;
      }
      return originalProject(run);
    });
    const latest = {
      lastRun: newer,
      updateAvailable: null,
      schedule: { channel: "stable", autoEnabled: false },
    };
    const progress = pendingReply(latest);
    let progressReads = 0;
    const request = updateStatusRequest((checkout) =>
      checkout
        ? {
            lastRun: older,
            updateAvailable: { currentVersion: "1.0.0", latestVersion: "2.0.0", channel: "beta" },
            schedule: { channel: "beta", autoEnabled: false },
          }
        : ++progressReads === 1
          ? {}
          : progressReads === 2
            ? progress.promise
            : latest,
    );
    const { overlays } = gatewayTest(request);
    await flushMicrotasks();
    const published = vi.fn();
    overlays.subscribe(published);
    const refresh = overlays.refreshUpdateStatus();
    await formattingStarted.promise;
    progress.resolve(latest);
    await vi.waitFor(() => expect(overlays.snapshot.updateRun).toEqual(newer));
    published.mockClear();
    formatting.resolve(null);
    await expect(refresh).resolves.toBe(true);
    expect(published).not.toHaveBeenCalledWith(
      expect.objectContaining({ updateSchedule: expect.objectContaining({ channel: "beta" }) }),
    );
    expect(overlays.snapshot).toMatchObject({
      updateRun: newer,
      updateAvailable: null,
      updateSchedule: latest.schedule,
    });
  });

  it("finishes a fresh target check after campaign reconciliation emits an availability event", async () => {
    const discovery = pendingReply({});
    const available = {
      channel: "dev",
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      currentSha: "a".repeat(40),
      upstreamSha: "b".repeat(40),
      commitsBehind: 9,
    };
    const response = {
      updateAvailable: available,
      schedule: {
        channel: "dev",
        autoEnabled: false,
        target: {
          kind: "git",
          upstreamRef: "origin/main",
          upstreamSha: available.upstreamSha,
          commitsBehind: 9,
        },
      },
    };
    let fetched = false;
    const request = updateStatusRequest((checkout) =>
      checkout ? discovery.promise : Promise.resolve(fetched ? response : {}),
    );
    const { harness, overlays } = gatewayTest(request);
    await flushMicrotasks();
    const refresh = overlays.refreshUpdateStatus();
    await flushMicrotasks();
    harness.emitEvent("update.available", {
      updateAvailable: null,
      schedule: { channel: "dev", autoEnabled: false },
    });
    fetched = true;
    discovery.resolve(response);
    await expect(refresh).resolves.toBe(true);
    expect(overlays.snapshot.updateAvailable).toEqual(available);
    expect(overlays.snapshot.updateSchedule?.target).toEqual(response.schedule.target);
  });

  it("settles a manual refresh when its administrator grant is renewed", async () => {
    const discovery = pendingReply({});
    const { harness, overlays } = automaticTest(
      updateStatusRequest((checkout) => (checkout ? discovery.promise : {})),
    );
    await flushMicrotasks();
    const refresh = overlays.refreshUpdateStatus();
    expect(overlays.snapshot.updateStatusRefreshing).toBe(true);
    harness.update({ hello: updateHello(AUTO_UPDATE_SCHEDULE) });
    discovery.resolve({ schedule: null });
    await expect(refresh).resolves.toBe(false);
    expect(overlays.snapshot.updateStatusRefreshing).toBe(false);
    expect(overlays.snapshot.updateSchedule).toEqual(AUTO_UPDATE_SCHEDULE);
  });

  it("keeps progress polling while checkout discovery exceeds the progress deadline", async () => {
    vi.useFakeTimers();
    const discovery = pendingReply({});
    const first = updateRunFixture({ phase: "staging", updatedAtMs: 1_000 });
    const next = updateRunFixture({ phase: "validating", updatedAtMs: 6_000 });
    let run = first;
    const request = updateStatusRequest((checkout) =>
      checkout
        ? discovery.promise
        : Promise.resolve({ activeRun: run, schedule: AUTO_UPDATE_SCHEDULE }),
    );
    const { overlays } = automaticTest(request);
    await flushMicrotasks();
    const refreshing = overlays.refreshUpdateStatus();
    await flushMicrotasks();
    run = next;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(overlays.snapshot.updateRun).toEqual(next);
    expect(overlays.snapshot.updateStatusRefreshing).toBe(true);

    discovery.resolve({ activeRun: first, schedule: AUTO_UPDATE_SCHEDULE });
    await expect(refreshing).resolves.toBe(true);
    expect(overlays.snapshot.updateRun).toEqual(next);
    expect(overlays.snapshot.updateStatusRefreshing).toBe(false);
  });

  it("adopts a completed run from a manual status check", async () => {
    const finished = updateRunFixture({
      updatedAtMs: 6_000,
      status: "succeeded",
      phase: "finished",
      finishedAtMs: 6_000,
    });
    const { overlays } = gatewayTest(async () => ({ lastRun: finished }));
    await expect(overlays.refreshUpdateStatus()).resolves.toBe(true);
    expect(overlays.snapshot.updateRun).toEqual(finished);
    expect(overlays.snapshot.updateRunning).toBe(false);
  });

  it.each(["unchanged", "access", "gateway"])(
    "keeps checkout error ownership until its %s scope releases it",
    async (scope) => {
      vi.useFakeTimers();
      let failCheckout = true;
      let failProgress = false;
      const request = updateStatusRequest((checkout) =>
        (checkout ? failCheckout : failProgress)
          ? Promise.reject(new Error(checkout ? "checkout unavailable" : "completion unavailable"))
          : Promise.resolve({ schedule: AUTO_UPDATE_SCHEDULE }),
      );
      const { harness, overlays } = automaticTest(request);
      await flushMicrotasks();
      await expect(overlays.refreshUpdateStatus()).resolves.toBe(false);
      expect(overlays.snapshot.updateStatusCheckBanner?.text).toContain("checkout unavailable");
      if (scope === "access") {
        for (const permission of ["operator.read", "operator.admin"]) {
          harness.update({ hello: updateHello(AUTO_UPDATE_SCHEDULE, permission) });
        }
      } else if (scope === "gateway") {
        harness.gateway.connection.gatewayUrl = "ws://replacement-gateway.test";
        harness.update({});
      }
      await flushMicrotasks();
      if (scope !== "unchanged") {
        expect(overlays.snapshot.updateStatusCheckBanner).toBeNull();
      }
      failProgress = true;
      harness.emitEvent("update.available", { schedule: automaticSchedule({ state: "applying" }) });
      harness.emitEvent("update.available", { schedule: AUTO_UPDATE_SCHEDULE });
      await flushMicrotasks();
      expect(overlays.snapshot.updateStatusCheckBanner?.text).toContain(
        scope === "unchanged" ? "checkout unavailable" : "completion unavailable",
      );
      failProgress = false;
      await vi.advanceTimersByTimeAsync(5_000);
      if (scope === "unchanged") {
        expect(overlays.snapshot.updateStatusCheckBanner?.text).toContain("checkout unavailable");
        failCheckout = false;
        await expect(overlays.refreshUpdateStatus()).resolves.toBe(true);
      }
      expect(overlays.snapshot.updateStatusCheckBanner).toBeNull();
    },
  );

  it("publishes new campaign state even when progress carries an older run", async () => {
    vi.useFakeTimers();
    const currentRun = updateRunFixture({ phase: "validating", updatedAtMs: 6_000 });
    const staleRun = updateRunFixture({ phase: "staging", updatedAtMs: 1_000 });
    const nextSchedule = automaticSchedule({ holdUntilMs: 90_000, updatedAtMs: 6_000 });
    let polled = false;
    const request = updateStatusRequest(() => ({
      activeRun: polled ? staleRun : currentRun,
      schedule: polled ? nextSchedule : AUTO_UPDATE_SCHEDULE,
    }));
    const { overlays } = automaticTest(request);
    const changed = vi.fn();
    overlays.subscribe(changed);
    await flushMicrotasks();
    polled = true;
    changed.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(overlays.snapshot.updateRun).toEqual(currentRun);
    expect(overlays.snapshot.updateSchedule).toEqual(nextSchedule);
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ updateRun: currentRun, updateSchedule: nextSchedule }),
    );
  });

  it("discovers a campaign after overlapping empty progress and starts polling it", async () => {
    vi.useFakeTimers();
    const discovery = pendingReply({});
    const reconciliation = pendingReply({});
    let checking = false;
    let discoveryFinished = false;
    let reconciled = false;
    const first = updateRunFixture({ phase: "staging", updatedAtMs: 1_000 });
    const next = updateRunFixture({ phase: "validating", updatedAtMs: 6_000 });
    const request = updateStatusRequest((checkout) => {
      if (checkout) {
        checking = true;
        return discovery.promise;
      }
      if (!checking || !discoveryFinished) {
        return Promise.resolve({ schedule: null });
      }
      return reconciled
        ? Promise.resolve({ activeRun: next, schedule: AUTO_UPDATE_SCHEDULE })
        : reconciliation.promise;
    });
    const { overlays } = gatewayTest(request);
    await flushMicrotasks();
    const refresh = overlays.refreshUpdateStatus();
    await flushMicrotasks();
    discoveryFinished = true;
    discovery.resolve({ schedule: AUTO_UPDATE_SCHEDULE });
    await flushMicrotasks();
    expect(overlays.snapshot.updateSchedule).toEqual(AUTO_UPDATE_SCHEDULE);
    expect(overlays.snapshot.updateStatusRefreshing).toBe(true);
    reconciliation.resolve({ activeRun: first, schedule: AUTO_UPDATE_SCHEDULE });
    await expect(refresh).resolves.toBe(true);
    expect(overlays.snapshot.updateStatusRefreshing).toBe(false);
    expect(overlays.snapshot.updateRun).toEqual(first);
    reconciled = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(overlays.snapshot.updateRun).toEqual(next);
  });

  it("keeps a late progress read without replacing a newer checkout comparison", async () => {
    const progress = pendingReply({});
    const freshSchedule = {
      ...AUTO_UPDATE_SCHEDULE,
      install: { kind: "git", git: { status: "behind", commitsBehind: 12 } },
    };
    let progressReads = 0;
    const request = updateStatusRequest((checkout) =>
      checkout
        ? Promise.resolve({ schedule: freshSchedule })
        : ++progressReads <= 2
          ? progress.promise
          : Promise.resolve({ schedule: freshSchedule }),
    );
    const { overlays } = automaticTest(request);
    const refresh = overlays.refreshUpdateStatus();
    await flushMicrotasks();
    expect(overlays.snapshot.updateSchedule).toEqual(freshSchedule);
    const run = updateRunFixture();
    progress.resolve({ activeRun: run, schedule: AUTO_UPDATE_SCHEDULE });
    await expect(refresh).resolves.toBe(true);
    expect(overlays.snapshot.updateRun).toEqual(run);
    expect(overlays.snapshot.updateSchedule).toEqual(freshSchedule);
  });

  it.each(["run", "legacy sentinel"])(
    "recovers a %s but rejects the check when progress remains unavailable",
    async (outcome) => {
      const run = updateRunFixture();
      const sentinel = updateSentinel("build-failed", 1_000);
      const request = updateStatusRequest((checkout) =>
        checkout
          ? Promise.resolve(outcome === "run" ? { activeRun: run } : { sentinel })
          : Promise.reject(new Error("fast progress unavailable")),
      );
      const { overlays, expectState } = gatewayTest(request, updateHello(undefined));
      await expect(overlays.refreshUpdateStatus()).resolves.toBe(false);
      expect(overlays.snapshot.updateStatusCheckBanner).not.toBeNull();
      if (outcome === "run") {
        expect(overlays.snapshot.updateRun).toEqual(run);
      } else {
        expectState({
          recordedUpdateAttempt: { timestampMs: 1_000 },
          updateStatusBanner: { text: expect.stringContaining("build-failed") },
        });
      }
    },
  );
});
