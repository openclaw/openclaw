import type { LitElement } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SparklineSample } from "../../components/sparkline-tile.tsx";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import "./debug-overlay.ts";
import "./debug-overlay-content.ts";
import {
  createDebugApplicationContext,
  diagnosticResponse,
  normalizedText,
  useDebugTestEnvironment,
} from "./debug.test-support.ts";

type TestDebugContent = HTMLElement & { readonly updateComplete: Promise<boolean> };

type TestDebugOverlay = HTMLElement & {
  readonly updateComplete: Promise<boolean>;
  context: ApplicationContext;
  toggle: () => void;
};

type TestSparkline = LitElement & { samples: readonly SparklineSample[] };

async function updateOverlayVitals(overlay: TestDebugOverlay): Promise<void> {
  await overlay.updateComplete;
  flush();
  await overlay.querySelector<TestDebugContent>("openclaw-debug-overlay-content")?.updateComplete;
  flush();
  for (const tile of overlay.querySelectorAll<TestSparkline>("openclaw-sparkline")) {
    await tile.updateComplete;
  }
}

useDebugTestEnvironment();

describe("DebugOverlay", () => {
  it("keeps vitals live while an active-run read is pending and minimizes invisible work", async () => {
    vi.useFakeTimers();
    const heldRuns = deferred<unknown>();
    const eventListeners = new Set<() => void>();
    let sampleCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "system.info") {
        return { eventLoop: { cpuCoreRatio: ++sampleCount / 10 } };
      }
      if (method === "sessions.list") {
        return heldRuns.promise;
      }
      return diagnosticResponse(method);
    });
    const context = createDebugApplicationContext(request);
    Object.assign(context.gateway, {
      subscribeEventLog(listener: () => void) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
    });
    const overlay = document.createElement("openclaw-debug-overlay") as TestDebugOverlay;
    overlay.context = context;
    document.body.append(overlay);
    const requestCount = (method: string) =>
      request.mock.calls.filter(([called]) => called === method).length;
    try {
      overlay.toggle();
      await vi.advanceTimersByTimeAsync(30_000);
      await updateOverlayVitals(overlay);
      expect(requestCount("sessions.list")).toBe(1);
      expect(requestCount("diagnostics.lanes")).toBe(4);
      expect(requestCount("system.info")).toBe(4);
      expect(normalizedText(overlay.querySelector(".gateway-vital--cpu"))).toContain("40%");
      expect(eventListeners.size).toBe(1);

      overlay.querySelector<HTMLButtonElement>('[aria-label="Minimize system busyness"]')!.click();
      await updateOverlayVitals(overlay);
      expect(eventListeners.size).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      await updateOverlayVitals(overlay);
      expect(requestCount("sessions.list")).toBe(1);
      expect(requestCount("diagnostics.lanes")).toBe(4);
      expect(requestCount("system.info")).toBe(5);
      expect(normalizedText(overlay.querySelector(".gateway-vital--cpu"))).toContain("50%");

      heldRuns.resolve({ sessions: [] });
      await vi.advanceTimersByTimeAsync(0);
      overlay.querySelector<HTMLButtonElement>('[aria-label="Expand system busyness"]')!.click();
      await updateOverlayVitals(overlay);
      expect(eventListeners.size).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(requestCount("sessions.list")).toBe(2);
      expect(requestCount("diagnostics.lanes")).toBe(5);
      expect(requestCount("system.info")).toBe(6);

      overlay.toggle();
      await updateOverlayVitals(overlay);
      expect(eventListeners.size).toBe(0);
      const closedCount = request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(request).toHaveBeenCalledTimes(closedCount);
    } finally {
      heldRuns.resolve({ sessions: [] });
      overlay.remove();
      vi.useRealTimers();
    }
  });

  it("defers hidden reads and catches up once when the tray becomes visible", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "hidden";
    const visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    const setVisibility = (value: DocumentVisibilityState) => {
      visibility = value;
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const request = vi.fn(async (method: string) => {
      if (method === "system.info") {
        return { eventLoop: { cpuCoreRatio: 0.2 } };
      }
      return method === "sessions.list" ? { sessions: [] } : diagnosticResponse(method);
    });
    const overlay = document.createElement("openclaw-debug-overlay") as TestDebugOverlay;
    overlay.context = createDebugApplicationContext(request);
    document.body.append(overlay);
    const expectReadCount = (count: number) => {
      for (const method of ["system.info", "sessions.list", "diagnostics.lanes"]) {
        expect(
          request.mock.calls.filter(([called]) => called === method),
          method,
        ).toHaveLength(count);
      }
    };
    try {
      overlay.toggle();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(request).not.toHaveBeenCalled();

      setVisibility("visible");
      globalThis.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
      await updateOverlayVitals(overlay);
      expectReadCount(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expectReadCount(2);

      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(30_000);
      expectReadCount(2);
      setVisibility("visible");
      globalThis.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
      expectReadCount(3);

      overlay.toggle();
      await updateOverlayVitals(overlay);
      setVisibility("hidden");
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(30_000);
      expectReadCount(3);
    } finally {
      overlay.remove();
      visibilitySpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("graphs bounded status samples without clamping CPU and resets history on reopen", async () => {
    vi.useFakeTimers();
    let sampleCount = 0;
    let uptimeMs = 60_000;
    let diskResponse: "available" | "single" | "empty" | "legacy" | "missing" | "rejected" =
      "available";
    const request = vi.fn(async (method: string) => {
      if (method === "system.info") {
        sampleCount += 1;
        const vitals = {
          eventLoop: {
            utilization: 0.42,
            cpuCoreRatio: 1 + sampleCount / 10,
            delayP99Ms: 10 + sampleCount,
            delayMaxMs: 87,
          },
          processMemory: {
            rssBytes: (400 + sampleCount) * 1_048_576,
            heapUsedBytes: 100 * 1_048_576,
            heapTotalBytes: 200 * 1_048_576,
          },
        };
        if (diskResponse === "rejected") {
          throw new Error("system info unavailable");
        }
        if (diskResponse === "legacy") {
          return { ...vitals, diskAvailableBytes: 500, diskTotalBytes: 1000, diskPath: "/legacy" };
        }
        if (diskResponse === "missing") {
          return vitals;
        }
        const disks = [
          {
            availableBytes: (700 - sampleCount) * 1_073_741_824,
            totalBytes: 1_000 * 1_073_741_824,
            path: "/",
          },
          {
            availableBytes: (300 - sampleCount * 2) * 1_073_741_824,
            totalBytes: 500 * 1_073_741_824,
            path: "/Volumes/Archive",
          },
        ];
        if (diskResponse === "single") {
          disks.pop();
        } else if (diskResponse === "empty") {
          disks.length = 0;
        }
        return { ...vitals, uptimeMs, disks: sampleCount % 2 ? disks : disks.toReversed() };
      }
      if (method === "sessions.list") {
        return { sessions: [] };
      }
      return diagnosticResponse(method);
    });
    const overlay = document.createElement("openclaw-debug-overlay") as TestDebugOverlay;
    overlay.context = createDebugApplicationContext(request);
    document.body.append(overlay);

    try {
      overlay.toggle();
      await vi.advanceTimersByTimeAsync(0);
      await overlay.updateComplete;

      const vitalUpdated = () => updateOverlayVitals(overlay);
      await vitalUpdated();
      expect(
        request.mock.calls
          .filter(([method]) => method === "status" || method === "system.info")
          .map(([method]) => method),
      ).toEqual(["system.info"]);
      const diskTile = (mountPath: string) =>
        overlay.querySelector<TestSparkline>(`.gateway-vital--disk[title="${mountPath}"]`);
      const rootDisk = diskTile("/");
      const archiveDisk = diskTile("/Volumes/Archive");

      // One sample: tiles show current values, charts wait for a second point.
      expect(overlay.querySelectorAll(".gateway-vital")).toHaveLength(5);
      expect(normalizedText(overlay.querySelector(".gateway-vital--cpu"))).toContain("Host —");
      expect(normalizedText(overlay.querySelector(".gateway-cpu-detail"))).toContain(
        "Event loop busy 42%",
      );
      expect(overlay.querySelector(".sparkline-tile__chart")).toBeNull();
      expect(normalizedText(overlay.querySelector(".debug-overlay__vitals-footer"))).toBe(
        "Uptime 1m",
      );

      await vi.advanceTimersByTimeAsync(10_000);
      await vitalUpdated();

      expect(normalizedText(overlay.querySelector(".gateway-vital--cpu"))).toContain("120%");
      expect(normalizedText(overlay.querySelector(".gateway-vital--memory"))).toContain("402 MB");
      expect(normalizedText(overlay.querySelector(".gateway-vital--memory"))).toContain(
        "heap 100 MB",
      );
      expect(normalizedText(overlay.querySelector(".gateway-vital--delay"))).toContain("12ms");
      expect(normalizedText(overlay.querySelector(".gateway-vital--delay"))).toContain("max 87ms");
      expect(normalizedText(diskTile("/"))).toContain("698 GB free");
      expect(normalizedText(diskTile("/"))).toContain("1000 GB total");
      expect(normalizedText(diskTile("/")?.querySelector(".sparkline-tile__label"))).toBe("Disk /");
      expect(
        normalizedText(diskTile("/Volumes/Archive")?.querySelector(".sparkline-tile__label")),
      ).toBe("Disk /Volumes/Archive");
      expect(normalizedText(diskTile("/Volumes/Archive"))).toContain("296 GB free");
      expect(normalizedText(diskTile("/Volumes/Archive"))).toContain("500 GB total");
      expect(diskTile("/")).toBe(rootDisk);
      expect(diskTile("/Volumes/Archive")).toBe(archiveDisk);
      expect(rootDisk?.samples.map((sample) => sample.value / 1_073_741_824)).toEqual([699, 698]);
      expect(archiveDisk?.samples.map((sample) => sample.value / 1_073_741_824)).toEqual([
        298, 296,
      ]);
      expect(overlay.querySelectorAll(".sparkline-tile__chart")).toHaveLength(5);
      // Healthy event loop: no tile carries the degraded tint.
      expect(overlay.querySelector(".gateway-vital[data-degraded]")).toBeNull();

      await vi.advanceTimersByTimeAsync(900_000);
      await vitalUpdated();

      const points = overlay
        .querySelector(".gateway-vital--cpu polyline")
        ?.getAttribute("points")
        ?.split(" ");
      expect(points).toHaveLength(90);

      uptimeMs = 0;
      overlay.toggle();
      overlay.toggle();
      await vi.advanceTimersByTimeAsync(0);
      await vitalUpdated();

      expect(overlay.querySelectorAll(".gateway-vital")).toHaveLength(5);
      expect(overlay.querySelector(".sparkline-tile__chart")).toBeNull();
      expect(normalizedText(overlay.querySelector(".debug-overlay__vitals-footer"))).toBe(
        "Uptime 1m",
      );

      diskResponse = "single";
      await vi.advanceTimersByTimeAsync(10_000);
      await vitalUpdated();
      expect(overlay.querySelectorAll(".gateway-vital--disk")).toHaveLength(1);
      expect(diskTile("/")?.samples).toHaveLength(2);
      diskResponse = "available";
      await vi.advanceTimersByTimeAsync(10_000);
      await vitalUpdated();
      expect(diskTile("/")?.samples).toHaveLength(3);
      expect(diskTile("/Volumes/Archive")?.samples).toHaveLength(1);

      for (const response of ["empty", "legacy", "missing"] as const) {
        diskResponse = response;
        await vi.advanceTimersByTimeAsync(10_000);
        await vitalUpdated();

        expect(overlay.querySelectorAll(".gateway-vital")).toHaveLength(3);
        expect(overlay.querySelector(".gateway-vital--disk")).toBeNull();
        expect(normalizedText(overlay.querySelector(".debug-overlay__vitals-footer"))).toBe(
          response === "empty" ? "Uptime 0ms" : undefined,
        );
        for (const vital of ["cpu", "memory", "delay"]) {
          expect(overlay.querySelector(`.gateway-vital--${vital}`)).not.toBeNull();
        }
      }
      diskResponse = "rejected";
      await vi.advanceTimersByTimeAsync(10_000);
      await vitalUpdated();
      expect(overlay.querySelectorAll(".gateway-vital")).toHaveLength(0);
      expect(normalizedText(overlay)).toContain("Unavailable");
      diskResponse = "available";
      await vi.advanceTimersByTimeAsync(10_000);
      await vitalUpdated();
      expect(overlay.querySelectorAll(".gateway-vital")).toHaveLength(5);
      expect(request.mock.calls.some(([method]) => method === "status")).toBe(false);
    } finally {
      overlay.remove();
      vi.useRealTimers();
    }
  });

  it.each([
    "same-client reconnect",
    "client replacement",
    "Gateway source replacement",
    "close and reopen",
  ])("discards pending samples and prior disk history on %s", async (transition) => {
    vi.useFakeTimers();
    const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
    const pending = deferred<unknown>();
    const replacement = deferred<unknown>();
    const firstInfo = {
      disks: [{ path: "/", totalBytes: 1000 * 1_073_741_824, availableBytes: 700 * 1_073_741_824 }],
      diskPath: "/",
      diskTotalBytes: 1000 * 1_073_741_824,
      diskAvailableBytes: 700 * 1_073_741_824,
    };
    let infoResponse: unknown = firstInfo;
    const request = vi.fn(async (method: string) => {
      if (method === "system.info") {
        return infoResponse;
      }
      if (method === "sessions.list") {
        return { sessions: [] };
      }
      return diagnosticResponse(method);
    });
    const context = createDebugApplicationContext(request);
    let snapshot = context.gateway.snapshot;
    const gateway = {
      ...context.gateway,
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (snapshot: ApplicationGatewaySnapshot) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const publishSnapshot = (next: ApplicationGatewaySnapshot) => {
      snapshot = next;
      for (const listener of listeners) {
        listener(snapshot);
      }
    };
    const overlay = document.createElement("openclaw-debug-overlay") as TestDebugOverlay;
    overlay.context = { ...context, gateway };
    document.body.append(overlay);
    try {
      overlay.toggle();
      await vi.advanceTimersByTimeAsync(10_000);
      await updateOverlayVitals(overlay);
      expect(overlay.querySelector<TestSparkline>(".gateway-vital--disk")?.samples).toHaveLength(2);

      infoResponse = pending.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      await updateOverlayVitals(overlay);
      expect(normalizedText(overlay.querySelector(".gateway-vital--disk"))).toContain(
        "700 GB free",
      );
      expect(overlay.querySelector(".debug-overlay__placeholder")).toBeNull();
      const callsBeforeTransition = request.mock.calls.filter(
        ([method]) => method === "system.info",
      ).length;
      const replacementInfo = {
        disks: [{ ...firstInfo.disks[0], availableBytes: 200 * 1_073_741_824 }],
        diskPath: "/",
        diskTotalBytes: firstInfo.diskTotalBytes,
        diskAvailableBytes: 200 * 1_073_741_824,
      };
      infoResponse = replacement.promise;
      if (transition === "same-client reconnect") {
        publishSnapshot({ ...snapshot, phase: "reconnecting" });
        await overlay.updateComplete;
        expect(overlay.querySelector(".gateway-vital--disk")).toBeNull();
        publishSnapshot({
          ...snapshot,
          phase: "connected",
          hello: gatewayHelloForMethods(["system.info"]),
        });
      } else if (transition === "client replacement") {
        publishSnapshot({
          ...snapshot,
          client: createDebugApplicationContext(request).gateway.snapshot.client,
        });
      } else if (transition === "close and reopen") {
        overlay.toggle();
        overlay.toggle();
      } else {
        overlay.context = { ...context, gateway: { ...gateway } };
      }
      await vi.advanceTimersByTimeAsync(0);
      await updateOverlayVitals(overlay);
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(
        callsBeforeTransition + 1,
      );

      expect(overlay.querySelector(".gateway-vital")).toBeNull();
      expect(overlay.querySelector(".sparkline-tile__chart")).toBeNull();
      pending.resolve(firstInfo);
      await vi.advanceTimersByTimeAsync(0);
      await updateOverlayVitals(overlay);
      expect(overlay.querySelector(".gateway-vital")).toBeNull();
      expect(overlay.querySelector(".sparkline-tile__chart")).toBeNull();
      expect(normalizedText(overlay)).not.toContain("700 GB free");

      infoResponse = replacementInfo;
      replacement.resolve(replacementInfo);
      await vi.advanceTimersByTimeAsync(0);
      await updateOverlayVitals(overlay);
      const disk = overlay.querySelector<TestSparkline>(".gateway-vital--disk");
      expect(normalizedText(disk)).toContain("200 GB free");
      expect(disk?.samples.map((sample) => sample.value / 1_073_741_824)).toEqual([200]);
      expect(disk?.querySelector("polyline")).toBeNull();

      await vi.advanceTimersByTimeAsync(10_000);
      await updateOverlayVitals(overlay);
      expect(disk?.samples.map((sample) => sample.value / 1_073_741_824)).toEqual([200, 200]);
    } finally {
      pending.resolve(firstInfo);
      replacement.resolve({});
      overlay.remove();
      vi.useRealTimers();
    }
    await waitForSolid(() => expect(listeners.size).toBe(0));
  });
});
