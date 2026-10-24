import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { registerListener } from "../../../../src/shared/listeners.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SparklineSample } from "../../components/sparkline-tile.tsx";
import type { SolidBridgeElement } from "../../lib/solid-bridge.ts";
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

type TestDebugContent = SolidBridgeElement<{
  context: ApplicationContext;
  minimized: boolean;
}>;

type TestDebugOverlay = SolidBridgeElement<{
  context: ApplicationContext;
  toggle: () => void;
}>;

type TestSparkline = SolidBridgeElement<{ samples: readonly SparklineSample[] }>;

async function updateOverlayVitals(overlay: TestDebugOverlay): Promise<void> {
  await overlay.updateComplete;
  flush();
  await overlay.querySelector<TestDebugContent>("openclaw-debug-overlay-content")?.updateComplete;
  flush();
  for (const tile of overlay.querySelectorAll<TestSparkline>("openclaw-sparkline")) {
    await tile.updateComplete;
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
useDebugTestEnvironment();

function mountOverlay(context: ApplicationContext) {
  const overlay = document.createElement("openclaw-debug-overlay") as TestDebugOverlay;
  overlay.context = context;
  document.body.append(overlay);
  const query = (selector: string) => overlay.querySelector<TestSparkline>(selector);
  const step = async (ms = 10_000) => {
    await vi.advanceTimersByTimeAsync(ms);
    await updateOverlayVitals(overlay);
  };
  return {
    overlay,
    query,
    text: (selector: string) => normalizedText(query(selector)),
    count: (selector: string) => overlay.querySelectorAll(selector).length,
    open: async () => {
      overlay.toggle();
      await waitForSolid(() => expect(query("openclaw-debug-overlay-content")).not.toBeNull());
      await step(0);
    },
    step,
  };
}

const gb = 1_073_741_824;
const makeDisk = (available: number, total = 1000, path = "/") => ({
  path,
  totalBytes: total * gb,
  availableBytes: available * gb,
});

function makeRequest(info: () => unknown, runs: () => unknown = () => ({ sessions: [] })) {
  return vi.fn(async (method: string) =>
    method === "system.info"
      ? info()
      : method === "sessions.list"
        ? runs()
        : diagnosticResponse(method),
  );
}

function readCounts(request: ReturnType<typeof makeRequest>) {
  return ["sessions.list", "diagnostics.lanes", "system.info"].map(
    (method) => request.mock.calls.filter(([called]) => called === method).length,
  );
}

function expectText(element: Element | null | undefined, ...values: string[]) {
  for (const value of values) {
    expect(normalizedText(element)).toContain(value);
  }
}

it("keeps vitals live while an active-run read is pending and minimizes invisible work", async () => {
  const heldRuns = deferred<unknown>();
  onTestFinished(() => heldRuns.resolve({ sessions: [] }));
  const eventListeners = new Set<() => void>();
  let sampleCount = 0;
  const request = makeRequest(
    () => ({ eventLoop: { cpuCoreRatio: ++sampleCount / 10 } }),
    () => heldRuns.promise,
  );
  const context = createDebugApplicationContext(request);
  Object.assign(context.gateway, {
    subscribeEventLog: (listener: () => void) => registerListener(eventListeners, listener),
  });
  const { overlay, text, step, open } = mountOverlay(context);
  await open();
  await step(30_000);
  expect(readCounts(request)).toEqual([1, 4, 4]);
  expect(text(".gateway-vital--cpu")).toContain("0.40 cores");
  expect(eventListeners.size).toBe(1);

  overlay.querySelector<HTMLButtonElement>('[aria-label="Minimize system busyness"]')!.click();
  await updateOverlayVitals(overlay);
  expect(eventListeners.size).toBe(0);
  await step();
  expect(readCounts(request)).toEqual([1, 4, 5]);
  expect(text(".gateway-vital--cpu")).toContain("0.50 cores");

  heldRuns.resolve({ sessions: [] });
  await vi.advanceTimersByTimeAsync(0);
  overlay.querySelector<HTMLButtonElement>('[aria-label="Expand system busyness"]')!.click();
  await updateOverlayVitals(overlay);
  expect(eventListeners.size).toBe(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(readCounts(request)).toEqual([2, 5, 6]);

  overlay.toggle();
  await updateOverlayVitals(overlay);
  expect(eventListeners.size).toBe(0);
  const closedCount = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(request).toHaveBeenCalledTimes(closedCount);
});

it("keeps settled section polling independent while a later active-run read is pending", async () => {
  const heldRuns = deferred<unknown>();
  onTestFinished(() => heldRuns.resolve({ sessions: [] }));
  let infoResponse: unknown = { eventLoop: { cpuCoreRatio: 0.1 } };
  let runReads = 0;
  const request = makeRequest(
    () => infoResponse,
    () => (++runReads === 1 ? { sessions: [] } : heldRuns.promise),
  );
  const { text, query, step, open } = mountOverlay(createDebugApplicationContext(request));
  await open();
  expect(text(".debug-overlay__count")).toContain("0 active");
  expect(text(".gateway-vital--cpu")).toContain("0.10 cores");

  for (const cpuCoreRatio of [0.2, 0.3, 0.4]) {
    const sample = deferred<unknown>();
    onTestFinished(() => sample.resolve({}));
    infoResponse = sample.promise;
    await step();
    sample.resolve({ eventLoop: { cpuCoreRatio } });
    await step(0);
    expect(text(".gateway-vital--cpu")).toContain(`${cpuCoreRatio.toFixed(2)} cores`);
  }

  expect(readCounts(request)).toEqual([2, 4, 4]);
  expect(query(".gateway-vital--cpu")?.samples).toHaveLength(4);
});

it("defers hidden reads and catches up once when the tray becomes visible", async () => {
  let visibility: DocumentVisibilityState = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const setVisibility = (value: DocumentVisibilityState) => {
    visibility = value;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const request = makeRequest(() => ({ eventLoop: { cpuCoreRatio: 0.2 } }));
  const { overlay, step, open } = mountOverlay(createDebugApplicationContext(request));
  const expectReadCount = (count: number) =>
    expect(readCounts(request)).toEqual([count, count, count]);
  await open();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(request).not.toHaveBeenCalled();

  setVisibility("visible");
  globalThis.dispatchEvent(new Event("focus"));
  await step(0);
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
});

it("graphs status samples without clamping CPU and resets history on reopen", async () => {
  let sampleCount = 0;
  let uptimeMs = 60_000;
  let diskResponse: "available" | "single" | "empty" | "legacy" | "missing" | "rejected" =
    "available";
  const request = makeRequest(() => {
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
      makeDisk(700 - sampleCount),
      makeDisk(300 - sampleCount * 2, 500, "/Volumes/Archive"),
    ];
    if (diskResponse === "single") {
      disks.pop();
    } else if (diskResponse === "empty") {
      disks.length = 0;
    }
    return { ...vitals, uptimeMs, disks: sampleCount % 2 ? disks : disks.toReversed() };
  });
  const { overlay, query, text, count, step, open } = mountOverlay(
    createDebugApplicationContext(request),
  );

  await open();
  await waitForSolid(() => expect(text(".gateway-vital--cpu")).toContain("1.10 cores"));

  await updateOverlayVitals(overlay);
  expect(
    request.mock.calls
      .filter(([method]) => method === "status" || method === "system.info")
      .map(([method]) => method),
  ).toEqual(["system.info"]);
  const diskTile = (mountPath: string) => query(`.gateway-vital--disk[title="${mountPath}"]`);
  const rootDisk = diskTile("/");
  const archiveDisk = diskTile("/Volumes/Archive");

  expect(count(".gateway-vital")).toBe(5);
  expect(text(".gateway-vital--cpu")).toContain("Host —");
  const cpuReadings = [...overlay.querySelectorAll(".gateway-cpu-detail dl > div")].map((row) => [
    normalizedText(row.querySelector("dt")),
    normalizedText(row.querySelector("dd")),
  ]);
  expect(cpuReadings).toContainEqual(["Event loop busy", "42%"]);
  expect(query(".sparkline-tile__chart")).toBeNull();
  expect(text(".debug-overlay__vitals-footer")).toBe("Uptime 1m");

  await step();

  expectText(query(".gateway-vital--cpu"), "1.20 cores");
  expectText(query(".gateway-vital--memory"), "402 MB", "heap 100 MB");
  expectText(query(".gateway-vital--delay"), "12ms", "max 87ms");
  for (const [path, original, samples, total] of [
    ["/", rootDisk, [699, 698], 1000],
    ["/Volumes/Archive", archiveDisk, [298, 296], 500],
  ] as const) {
    const disk = diskTile(path);
    expectText(disk, `${samples[1]} GB free`, `${total} GB total`);
    expect(normalizedText(disk?.querySelector(".sparkline-tile__label"))).toBe(`Disk ${path}`);
    expect(disk).toBe(original);
    expect(disk?.samples.map((sample) => sample.value / gb)).toEqual(samples);
  }
  expect(count(".sparkline-tile__chart")).toBe(5);
  expect(overlay.querySelector(".gateway-vital[data-degraded]")).toBeNull();

  const points = query(".gateway-vital--cpu polyline")?.getAttribute("points")?.split(" ");
  expect(points).toHaveLength(2);

  uptimeMs = 0;
  overlay.toggle();
  overlay.toggle();
  await step(0);

  expect(count(".gateway-vital")).toBe(5);
  expect(query(".sparkline-tile__chart")).toBeNull();
  expect(text(".debug-overlay__vitals-footer")).toBe("Uptime 1m");

  for (const [response, samples] of [
    ["single", 2],
    ["available", 3],
  ] as const) {
    diskResponse = response;
    await step();
    if (response === "single") {
      expect(count(".gateway-vital--disk")).toBe(1);
    }
    expect(diskTile("/")?.samples).toHaveLength(samples);
  }
  expect(diskTile("/Volumes/Archive")?.samples).toHaveLength(1);

  for (const response of ["empty", "legacy", "missing"] as const) {
    diskResponse = response;
    await step();

    expect(count(".gateway-vital")).toBe(3);
    expect(query(".gateway-vital--disk")).toBeNull();
    expect(text(".debug-overlay__vitals-footer")).toBe(
      response === "empty" ? "Uptime 0ms" : undefined,
    );
    for (const vital of ["cpu", "memory", "delay"]) {
      expect(query(`.gateway-vital--${vital}`)).not.toBeNull();
    }
  }
  diskResponse = "rejected";
  await step();
  expect(count(".gateway-vital")).toBe(0);
  expect(normalizedText(overlay)).toContain("Unavailable");
  diskResponse = "available";
  await step();
  expect(count(".gateway-vital")).toBe(5);
  expect(request.mock.calls.some(([method]) => method === "status")).toBe(false);
});

it("retains the latest 90 status samples in the minimized content", async () => {
  let sampleCount = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "system.info") {
      return { eventLoop: { cpuCoreRatio: ++sampleCount } };
    }
    throw new Error(`Unexpected diagnostics method: ${method}`);
  });
  const content = document.createElement("openclaw-debug-overlay-content") as TestDebugContent;
  content.context = createDebugApplicationContext(request);
  content.minimized = true;
  document.body.append(content);
  const cpu = () => content.querySelector<TestSparkline>(".gateway-vital--cpu");

  await content.updateComplete;
  vi.advanceTimersByTime(0);
  await waitForSolid(() => expect(cpu()?.samples).toHaveLength(1));
  for (let value = 2; value <= 91; value += 1) {
    vi.advanceTimersByTime(10_000);
    await waitForSolid(() => expect(cpu()?.samples.at(-1)?.value).toBe(value));
  }
  await waitForSolid(() => {
    const tile = cpu();
    expect(sampleCount).toBe(91);
    expect(tile?.samples).toHaveLength(90);
    expect([tile?.samples[0]?.value, tile?.samples.at(-1)?.value]).toEqual([2, 91]);
    expect(tile?.querySelector("polyline")?.getAttribute("points")?.split(" ")).toHaveLength(90);
  });
});

it.each([
  "same-client reconnect",
  "client replacement",
  "Gateway source replacement",
  "close and reopen",
])("discards pending samples and prior disk history on %s", async (transition) => {
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const pending = deferred<unknown>();
  const replacement = deferred<unknown>();
  onTestFinished(() => {
    pending.resolve(firstInfo);
    replacement.resolve({});
  });
  const firstInfo = { disks: [makeDisk(700)] };
  let infoResponse: unknown = firstInfo;
  const request = makeRequest(() => infoResponse);
  const context = createDebugApplicationContext(request);
  let snapshot = context.gateway.snapshot;
  const gateway = {
    ...context.gateway,
    get snapshot() {
      return snapshot;
    },
    subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) =>
      registerListener(listeners, listener),
  };
  const publishSnapshot = (next: ApplicationGatewaySnapshot) => {
    snapshot = next;
    for (const listener of listeners) {
      listener(snapshot);
    }
  };
  const { overlay, query, text, step } = mountOverlay({ ...context, gateway });
  overlay.toggle();
  // The bridge commit precedes the lazy content and its first sample.
  await overlay.updateComplete;
  await vi.dynamicImportSettled();
  await waitForSolid(() => expect(query(".gateway-vital--disk")?.samples).toHaveLength(1));
  await step();
  expect(query(".gateway-vital--disk")?.samples).toHaveLength(2);

  infoResponse = pending.promise;
  await step();
  expect(text(".gateway-vital--disk")).toContain("700 GB free");
  expect(overlay.querySelector(".debug-overlay__placeholder")).toBeNull();
  const callsBeforeTransition = request.mock.calls.filter(
    ([method]) => method === "system.info",
  ).length;
  const replacementInfo = { disks: [makeDisk(200)] };
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
  await step(0);
  expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(
    callsBeforeTransition + 1,
  );

  expect(query(".gateway-vital, .sparkline-tile__chart")).toBeNull();
  pending.resolve(firstInfo);
  await step(0);
  expect(query(".gateway-vital, .sparkline-tile__chart")).toBeNull();
  expect(normalizedText(overlay)).not.toContain("700 GB free");

  infoResponse = replacementInfo;
  replacement.resolve(replacementInfo);
  await step(0);
  const disk = query(".gateway-vital--disk");
  expect(normalizedText(disk)).toContain("200 GB free");
  expect(disk?.samples.map((sample) => sample.value / gb)).toEqual([200]);
  expect(disk?.querySelector("polyline")).toBeNull();

  await step();
  expect(disk?.samples.map((sample) => sample.value / gb)).toEqual([200, 200]);
  overlay.remove();
  await waitForSolid(() => expect(listeners.size).toBe(0));
});
