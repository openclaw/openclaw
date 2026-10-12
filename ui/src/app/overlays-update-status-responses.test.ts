// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
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
  it("settles a manual refresh when its administrator grant is renewed", async () => {
    const discovery = deferred<unknown>();
    const harness = createAutomaticUpdateHarness((method, params) =>
      method === "update.status" && (params as { refreshCheckout?: boolean }).refreshCheckout
        ? discovery.promise
        : Promise.resolve({}),
    );
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await flushMicrotasks();
      const refresh = overlays.refreshUpdateStatus();
      expect(overlays.snapshot.updateStatusRefreshing).toBe(true);
      harness.update({
        hello: {
          auth: { role: "operator", scopes: ["operator.admin"] },
          snapshot: { updateSchedule: AUTO_UPDATE_SCHEDULE },
        } as ApplicationGatewaySnapshot["hello"],
      });
      discovery.resolve({ schedule: null });
      await expect(refresh).resolves.toBe(false);
      expect(overlays.snapshot.updateStatusRefreshing).toBe(false);
      expect(overlays.snapshot.updateSchedule).toEqual(AUTO_UPDATE_SCHEDULE);
    } finally {
      discovery.resolve({});
      overlays.dispose();
    }
  });

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

  it("adopts a completed run from a manual status check", async () => {
    const finished = updateRunFixture({
      updatedAtMs: 6_000,
      status: "succeeded",
      phase: "finished",
      finishedAtMs: 6_000,
    });
    const harness = createGatewayHarness(client(async () => ({ lastRun: finished })));
    const overlays = createApplicationOverlays(harness.gateway);
    try {
      await expect(overlays.refreshUpdateStatus()).resolves.toBe(true);
      expect(overlays.snapshot.updateRun).toEqual(finished);
      expect(overlays.snapshot.updateRunning).toBe(false);
    } finally {
      overlays.dispose();
    }
  });

  it.each(["unchanged", "access", "gateway"])(
    "keeps checkout error ownership until its %s scope releases it",
    async (scope) => {
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
        if (scope === "access") {
          for (const permission of ["operator.read", "operator.admin"]) {
            harness.update({
              hello: {
                auth: { role: "operator", scopes: [permission] },
                snapshot: { updateSchedule: AUTO_UPDATE_SCHEDULE },
              } as ApplicationGatewaySnapshot["hello"],
            });
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
        harness.emitEvent("update.available", {
          schedule: {
            ...AUTO_UPDATE_SCHEDULE,
            campaign: { ...AUTO_UPDATE_SCHEDULE.campaign, state: "applying" },
          },
        });
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
      expect(overlays.snapshot.updateSchedule).toEqual(AUTO_UPDATE_SCHEDULE);
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
});
