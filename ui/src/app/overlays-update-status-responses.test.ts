// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { UpdateScheduleState } from "../api/types.ts";
import { createUpdateRunFixture as updateRunFixture } from "../test-helpers/update-run.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import {
  client,
  createGatewayHarness,
  flushMicrotasks,
  type RequestFn,
} from "./overlays-access.test-support.ts";
import {
  AUTO_UPDATE_SCHEDULE,
  createAutomaticUpdateHarness,
} from "./overlays-update-campaign.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";

afterEach(() => vi.useRealTimers());

describe("application update status response ownership", () => {
  it("keeps progress polling while checkout discovery exceeds the progress deadline", async () => {
    vi.useFakeTimers();
    const discovery = deferred<unknown>();
    const first = updateRunFixture({ phase: "staging", updatedAtMs: 1_000 });
    const next = updateRunFixture({ phase: "validating", updatedAtMs: 6_000 });
    let run = first;
    const request = vi.fn<RequestFn>((method, params) => {
      if (method !== "update.status") {
        return Promise.resolve({});
      }
      return (params as { refreshCheckout?: boolean }).refreshCheckout
        ? discovery.promise
        : Promise.resolve({ activeRun: run, schedule: AUTO_UPDATE_SCHEDULE });
    });
    const harness = createAutomaticUpdateHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
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
    } finally {
      discovery.resolve({});
      overlays.dispose();
    }
  });

  it("accepts a newer terminal run from discovery after fast progress without a campaign", async () => {
    const discovery = deferred<unknown>();
    const first = updateRunFixture({ updatedAtMs: 1_000 });
    const finished = updateRunFixture({
      updatedAtMs: 6_000,
      status: "succeeded",
      phase: "finished",
      finishedAtMs: 6_000,
    });
    const request = vi.fn<RequestFn>((method, params) =>
      method === "update.status"
        ? (params as { refreshCheckout?: boolean }).refreshCheckout
          ? discovery.promise
          : Promise.resolve({ activeRun: first })
        : Promise.resolve({}),
    );
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      const refreshing = overlays.refreshUpdateStatus();
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(first);
      discovery.resolve({ lastRun: finished });
      await expect(refreshing).resolves.toBe(true);
      expect(overlays.snapshot.updateRun).toEqual(finished);
      expect(overlays.snapshot.updateRunning).toBe(false);
    } finally {
      discovery.resolve({});
      overlays.dispose();
    }
  });

  it("retires a completion status error after a successful progress poll", async () => {
    vi.useFakeTimers();
    let fail = false;
    const request = vi.fn<RequestFn>((method) =>
      method !== "update.status"
        ? Promise.resolve({})
        : fail
          ? Promise.reject(new Error("completion status unavailable"))
          : Promise.resolve({ schedule: AUTO_UPDATE_SCHEDULE }),
    );
    const harness = createAutomaticUpdateHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      fail = true;
      harness.emitEvent("update.available", {
        schedule: {
          ...AUTO_UPDATE_SCHEDULE,
          campaign: { ...AUTO_UPDATE_SCHEDULE.campaign, state: "applying" },
        },
      });
      harness.emitEvent("update.available", { schedule: AUTO_UPDATE_SCHEDULE });
      await flushMicrotasks();
      expect(overlays.snapshot.updateStatusCheckBanner?.text).toContain(
        "completion status unavailable",
      );
      fail = false;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(overlays.snapshot.updateStatusCheckBanner).toBeNull();
    } finally {
      overlays.dispose();
    }
  });

  it("retains a checkout failure across completion failure and successful progress", async () => {
    vi.useFakeTimers();
    let failCheckout = true;
    let failProgress = false;
    const request = vi.fn<RequestFn>((method, params) => {
      if (method !== "update.status") {
        return Promise.resolve({});
      }
      const checkout = (params as { refreshCheckout?: boolean }).refreshCheckout;
      return (checkout ? failCheckout : failProgress)
        ? Promise.reject(new Error(checkout ? "checkout unavailable" : "completion unavailable"))
        : Promise.resolve({ schedule: AUTO_UPDATE_SCHEDULE });
    });
    const harness = createAutomaticUpdateHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      await expect(overlays.refreshUpdateStatus()).resolves.toBe(false);
      expect(overlays.snapshot.updateStatusCheckBanner?.text).toContain("checkout unavailable");
      failProgress = true;
      harness.emitEvent("update.available", {
        schedule: {
          ...AUTO_UPDATE_SCHEDULE,
          campaign: { ...AUTO_UPDATE_SCHEDULE.campaign, state: "applying" },
        },
      });
      harness.emitEvent("update.available", { schedule: AUTO_UPDATE_SCHEDULE });
      await flushMicrotasks();
      expect(overlays.snapshot.updateStatusCheckBanner?.text).toContain("checkout unavailable");
      failProgress = false;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(overlays.snapshot.updateStatusCheckBanner?.text).toContain("checkout unavailable");
      failCheckout = false;
      await expect(overlays.refreshUpdateStatus()).resolves.toBe(true);
      expect(overlays.snapshot.updateStatusCheckBanner).toBeNull();
    } finally {
      overlays.dispose();
    }
  });

  it.each(["access", "gateway"])(
    "retires checkout error ownership when the same client's %s changes",
    async (scope) => {
      vi.useFakeTimers();
      let failProgress = false;
      const request = vi.fn<RequestFn>((method, params) => {
        if (method !== "update.status") {
          return Promise.resolve({});
        }
        const checkout = (params as { refreshCheckout?: boolean }).refreshCheckout;
        return checkout || failProgress
          ? Promise.reject(new Error(checkout ? "checkout unavailable" : "completion unavailable"))
          : Promise.resolve({ schedule: AUTO_UPDATE_SCHEDULE });
      });
      const harness = createAutomaticUpdateHarness(request);
      const overlays = createApplicationOverlays(harness.gateway);
      try {
        await flushMicrotasks();
        await expect(overlays.refreshUpdateStatus()).resolves.toBe(false);
        expect(overlays.snapshot.updateStatusCheckBanner?.text).toContain("checkout unavailable");
        if (scope === "access") {
          harness.update({
            hello: {
              auth: { role: "operator", scopes: ["operator.read"] },
              snapshot: { updateSchedule: AUTO_UPDATE_SCHEDULE },
            } as ApplicationGatewaySnapshot["hello"],
          });
          harness.update({
            hello: {
              auth: { role: "operator", scopes: ["operator.admin"] },
              snapshot: { updateSchedule: AUTO_UPDATE_SCHEDULE },
            } as ApplicationGatewaySnapshot["hello"],
          });
        } else {
          harness.gateway.connection.gatewayUrl = "ws://replacement-gateway.test";
          harness.update({});
        }
        await flushMicrotasks();
        expect(overlays.snapshot.updateStatusCheckBanner).toBeNull();
        failProgress = true;
        harness.emitEvent("update.available", {
          schedule: {
            ...AUTO_UPDATE_SCHEDULE,
            campaign: { ...AUTO_UPDATE_SCHEDULE.campaign, state: "applying" },
          },
        });
        harness.emitEvent("update.available", { schedule: AUTO_UPDATE_SCHEDULE });
        await flushMicrotasks();
        expect(overlays.snapshot.updateStatusCheckBanner?.text).toContain("completion unavailable");
        failProgress = false;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(overlays.snapshot.updateStatusCheckBanner).toBeNull();
      } finally {
        overlays.dispose();
      }
    },
  );

  it("publishes new campaign state even when progress carries an older run", async () => {
    vi.useFakeTimers();
    const currentRun = updateRunFixture({ phase: "validating", updatedAtMs: 6_000 });
    const staleRun = updateRunFixture({ phase: "staging", updatedAtMs: 1_000 });
    const nextSchedule = {
      ...AUTO_UPDATE_SCHEDULE,
      campaign: { ...AUTO_UPDATE_SCHEDULE.campaign, holdUntilMs: 90_000, updatedAtMs: 6_000 },
    };
    let polled = false;
    const request = vi.fn<RequestFn>((method) =>
      Promise.resolve(
        method === "update.status"
          ? {
              activeRun: polled ? staleRun : currentRun,
              schedule: polled ? nextSchedule : AUTO_UPDATE_SCHEDULE,
            }
          : {},
      ),
    );
    const harness = createAutomaticUpdateHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    const changed = vi.fn();
    const unsubscribe = overlays.subscribe(changed);
    try {
      await flushMicrotasks();
      polled = true;
      changed.mockClear();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(overlays.snapshot.updateRun).toEqual(currentRun);
      expect(overlays.snapshot.updateSchedule).toEqual(nextSchedule);
      expect(changed).toHaveBeenLastCalledWith(
        expect.objectContaining({ updateRun: currentRun, updateSchedule: nextSchedule }),
      );
    } finally {
      unsubscribe();
      overlays.dispose();
    }
  });

  it.each([
    [
      "advanced campaign",
      {
        ...AUTO_UPDATE_SCHEDULE,
        campaign: {
          ...AUTO_UPDATE_SCHEDULE.campaign,
          state: "applying",
          holdUntilMs: 90_000,
          updatedAtMs: 2_000,
        },
      },
    ],
    [
      "replacement campaign",
      {
        ...AUTO_UPDATE_SCHEDULE,
        autoEnabled: false,
        target: { kind: "package", version: "3.0.0" },
        campaign: { ...AUTO_UPDATE_SCHEDULE.campaign, id: "campaign-next", updatedAtMs: 2_000 },
      },
    ],
    ["removed campaign", { channel: "stable", autoEnabled: true }],
    ["cleared schedule", null],
    ["changed channel", { ...AUTO_UPDATE_SCHEDULE, channel: "dev" }],
    ["omitted schedule", undefined],
  ] as const)(
    "keeps the %s and checkout metadata in either response order",
    async (_label, progressSchedule) => {
      for (const checkoutFirst of [false, true]) {
        const discovery = deferred<unknown>();
        const progress = deferred<unknown>();
        const followup = deferred<unknown>();
        const install = { kind: "git", git: { status: "behind", commitsBehind: 12 } } as const;
        let checking = false;
        let progressReads = 0;
        const request = vi.fn<RequestFn>((method, params) => {
          if (method !== "update.status") {
            return Promise.resolve({});
          }
          if ((params as { refreshCheckout?: boolean }).refreshCheckout) {
            checking = true;
            return discovery.promise;
          }
          return !checking
            ? Promise.resolve({})
            : ++progressReads === 1
              ? progress.promise
              : followup.promise;
        });
        const harness = createAutomaticUpdateHarness(request);
        const overlays = createApplicationOverlays(harness.gateway);
        try {
          await flushMicrotasks();
          const refresh = overlays.refreshUpdateStatus();
          const run = updateRunFixture({ updatedAtMs: 2_000 });
          const available = { currentVersion: "1.0.0", latestVersion: "3.0.0", channel: "stable" };
          const progressResponse = {
            ...(progressSchedule === undefined ? {} : { schedule: progressSchedule }),
            activeRun: run,
            updateAvailable: available,
          };
          if (!checkoutFirst) {
            progress.resolve(progressResponse);
            await flushMicrotasks();
          }
          discovery.resolve({
            schedule: { ...AUTO_UPDATE_SCHEDULE, install },
            updateAvailable: null,
          });
          await expect(refresh).resolves.toBe(true);
          if (checkoutFirst) {
            progress.resolve(progressResponse);
            await flushMicrotasks();
          }
          const expected: UpdateScheduleState | null =
            progressSchedule === undefined
              ? { ...AUTO_UPDATE_SCHEDULE, install }
              : progressSchedule?.channel === "stable"
                ? { ...progressSchedule, install }
                : progressSchedule;
          expect(overlays.snapshot.updateSchedule).toEqual(expected);
          expect(overlays.snapshot.updateAvailable).toEqual(available);
          expect(overlays.snapshot.updateRun).toEqual(run);
          expect(overlays.snapshot.heldUpdateCampaignId).toBe(
            expected?.campaign?.holdUntilMs === undefined ? null : expected.campaign.id,
          );
        } finally {
          discovery.resolve({});
          progress.resolve({});
          followup.resolve({});
          overlays.dispose();
        }
      }
    },
  );

  it("discovers a campaign after overlapping empty progress and starts polling it", async () => {
    vi.useFakeTimers();
    const discovery = deferred<unknown>();
    const reconciliation = deferred<unknown>();
    let checking = false;
    let discoveryFinished = false;
    let reconciled = false;
    const first = updateRunFixture({ phase: "staging", updatedAtMs: 1_000 });
    const next = updateRunFixture({ phase: "validating", updatedAtMs: 6_000 });
    const request = vi.fn<RequestFn>((method, params) => {
      if (method !== "update.status") {
        return Promise.resolve({});
      }
      if ((params as { refreshCheckout?: boolean }).refreshCheckout) {
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
    const harness = createGatewayHarness(client(request));
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      const refresh = overlays.refreshUpdateStatus();
      await flushMicrotasks();
      discoveryFinished = true;
      discovery.resolve({ schedule: AUTO_UPDATE_SCHEDULE });
      await expect(refresh).resolves.toBe(true);
      expect(overlays.snapshot.updateSchedule).toBeNull();
      expect(overlays.snapshot.updateStatusRefreshing).toBe(false);
      reconciliation.resolve({ activeRun: first, schedule: AUTO_UPDATE_SCHEDULE });
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(first);
      reconciled = true;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(overlays.snapshot.updateRun).toEqual(next);
    } finally {
      discovery.resolve({});
      reconciliation.resolve({});
      overlays.dispose();
    }
  });

  it("keeps a late progress read without replacing a newer checkout comparison", async () => {
    const progress = deferred<unknown>();
    const freshSchedule = {
      ...AUTO_UPDATE_SCHEDULE,
      install: { kind: "git", git: { status: "behind", commitsBehind: 12 } },
    };
    let progressReads = 0;
    const request = vi.fn<RequestFn>((method, params) => {
      if (method !== "update.status") {
        return Promise.resolve({});
      }
      return (params as { refreshCheckout?: boolean }).refreshCheckout
        ? Promise.resolve({ schedule: freshSchedule })
        : ++progressReads <= 2
          ? progress.promise
          : Promise.resolve({ schedule: freshSchedule });
    });
    const harness = createAutomaticUpdateHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await expect(overlays.refreshUpdateStatus()).resolves.toBe(true);
      const run = updateRunFixture();
      progress.resolve({ activeRun: run, schedule: AUTO_UPDATE_SCHEDULE });
      await flushMicrotasks();
      expect(overlays.snapshot.updateRun).toEqual(run);
      expect(overlays.snapshot.updateSchedule).toEqual(freshSchedule);
    } finally {
      progress.resolve({});
      overlays.dispose();
    }
  });

  it.each(["run", "legacy sentinel"])(
    "recovers a %s from discovery when fast progress fails without a campaign",
    async (outcome) => {
      const run = updateRunFixture();
      const sentinel = {
        kind: "update",
        status: "error",
        ts: 1_000,
        stats: { reason: "build-failed" },
      };
      const request = vi.fn<RequestFn>((method, params) => {
        if (method !== "update.status") {
          return Promise.resolve({});
        }
        return (params as { refreshCheckout?: boolean }).refreshCheckout
          ? Promise.resolve(outcome === "run" ? { activeRun: run } : { sentinel })
          : Promise.reject(new Error("fast progress unavailable"));
      });
      const harness = createGatewayHarness(client(request));
      harness.update({
        hello: {
          auth: { role: "operator", scopes: ["operator.admin"] },
        } as ApplicationGatewaySnapshot["hello"],
      });
      const overlays = createApplicationOverlays(harness.gateway);
      try {
        await expect(overlays.refreshUpdateStatus()).resolves.toBe(true);
        if (outcome === "run") {
          expect(overlays.snapshot.updateRun).toEqual(run);
        } else {
          expect(overlays.snapshot.recordedUpdateAttempt?.timestampMs).toBe(1_000);
          expect(overlays.snapshot.updateStatusBanner?.text).toContain("build-failed");
        }
      } finally {
        overlays.dispose();
      }
    },
  );

  it("does not restore a legacy failure superseded during checkout discovery", async () => {
    const discovery = deferred<unknown>();
    const sentinel = { kind: "update", status: "error", ts: 2_000, stats: { reason: "current" } };
    const request = vi.fn<RequestFn>((method, params) => {
      if (method !== "update.status") {
        return Promise.resolve({});
      }
      return (params as { refreshCheckout?: boolean }).refreshCheckout
        ? discovery.promise
        : Promise.resolve({ sentinel });
    });
    const harness = createAutomaticUpdateHarness(request);
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      const checking = overlays.refreshUpdateStatus();
      await flushMicrotasks();
      discovery.resolve({ sentinel: { ...sentinel, ts: 1_000, stats: { reason: "obsolete" } } });
      await expect(checking).resolves.toBe(true);
      expect(overlays.snapshot.recordedUpdateAttempt?.timestampMs).toBe(2_000);
      expect(overlays.snapshot.updateStatusBanner?.text).toContain("current");
      expect(overlays.snapshot.reportableUpdateFailureId).toBe("recorded:2000");
    } finally {
      discovery.resolve({});
      overlays.dispose();
    }
  });
});
