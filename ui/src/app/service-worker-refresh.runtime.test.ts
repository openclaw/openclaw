/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { scheduleStaleChunkReload } from "./stale-chunk-reload.ts";
import { refreshControlUiServiceWorker } from "./sw-refresh.runtime.ts";

vi.mock("./stale-chunk-reload.ts", () => ({ scheduleStaleChunkReload: vi.fn() }));

beforeEach(() => {
  vi.mocked(scheduleStaleChunkReload).mockReset();
  vi.mocked(scheduleStaleChunkReload).mockImplementation(
    async (options) => options?.canReload?.() !== false,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function createWorker(version = CONTROL_UI_BUILD_INFO.buildId) {
  return Object.assign(new EventTarget(), {
    state: "activated" as ServiceWorkerState,
    postMessage: vi.fn((_message: unknown, ports: MessagePort[]) => {
      ports[0]?.postMessage({ type: "sw-updated", version });
    }),
  });
}

function installRegistration(active = createWorker()) {
  const registration = {
    active: active as unknown as ServiceWorker,
    installing: null as ServiceWorker | null,
    waiting: null as ServiceWorker | null,
    update: vi.fn(async () => undefined),
  };
  vi.stubGlobal("navigator", {
    serviceWorker: { controller: active, getRegistration: async () => registration },
  });
  return registration;
}

describe("Control UI service-worker reconnect refresh", () => {
  it.each(["lookup", "update", "installing"] as const)(
    "releases reconnect after a stalled %s and ignores late completion",
    async (phase) => {
      vi.useFakeTimers();
      const replacement = createWorker("replacement");
      replacement.state = "installing";
      const registration = installRegistration();
      let complete = () => {};
      if (phase === "lookup") {
        vi.stubGlobal("navigator", {
          serviceWorker: {
            getRegistration: () =>
              new Promise((resolve) => {
                complete = () => resolve(registration);
              }),
          },
        });
      } else if (phase === "update") {
        registration.update.mockImplementation(
          () =>
            new Promise((resolve) => {
              complete = () => resolve(undefined);
            }),
        );
      } else {
        registration.installing = replacement as unknown as ServiceWorker;
        complete = () => {
          replacement.state = "activated";
          replacement.dispatchEvent(new Event("statechange"));
        };
      }
      const refresh = refreshControlUiServiceWorker();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(refresh).resolves.toBe(false);
      complete();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(scheduleStaleChunkReload).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("recovers a document that missed the active worker's activation", async () => {
    const active = createWorker("already-active-build");
    const registration = installRegistration(active);
    // No second activation: the same worker already claimed this sleeping page.
    await expect(refreshControlUiServiceWorker()).resolves.toBe(true);
    expect(scheduleStaleChunkReload).toHaveBeenCalledOnce();
    expect(registration.update).toHaveBeenCalledOnce();
  });

  it.each(["discovered", "installing", "waiting"] as const)(
    "holds reconnect work until a %s replacement can identify its build",
    async (phase) => {
      const replacement = createWorker("next-build");
      replacement.state = "installing";
      const registration = installRegistration();
      if (phase === "discovered") {
        registration.update.mockImplementation(async () => {
          registration.installing = replacement as unknown as ServiceWorker;
        });
      } else {
        registration[phase] = replacement as unknown as ServiceWorker;
      }
      const listening = vi.spyOn(replacement, "addEventListener");
      let settled = false;
      const refresh = refreshControlUiServiceWorker().then((retired) => {
        settled = true;
        return retired;
      });
      await vi.waitFor(() => expect(listening).toHaveBeenCalled());
      expect(settled).toBe(false);
      expect(registration.update).toHaveBeenCalledTimes(phase === "discovered" ? 1 : 0);
      registration.active = replacement as unknown as ServiceWorker;
      registration.installing = null;
      registration.waiting = null;
      replacement.state = "activated";
      replacement.dispatchEvent(new Event("statechange"));
      await expect(refresh).resolves.toBe(true);
    },
  );

  it("releases reconnect work when activation serves the document's own build", async () => {
    const replacement = createWorker();
    replacement.state = "installing";
    const registration = installRegistration(createWorker("previous-build"));
    registration.installing = replacement as unknown as ServiceWorker;
    const listening = vi.spyOn(replacement, "addEventListener");
    const refresh = refreshControlUiServiceWorker();
    await vi.waitFor(() => expect(listening).toHaveBeenCalled());
    registration.active = replacement as unknown as ServiceWorker;
    replacement.state = "activated";
    replacement.dispatchEvent(new Event("statechange"));
    await expect(refresh).resolves.toBe(false);
    expect(scheduleStaleChunkReload).not.toHaveBeenCalled();
  });

  it("does not hold reconnect work when document recovery declines the reload", async () => {
    const registration = installRegistration(createWorker("next-build"));
    vi.mocked(scheduleStaleChunkReload).mockResolvedValue(false);
    await expect(refreshControlUiServiceWorker()).resolves.toBe(false);
    expect(registration.update).toHaveBeenCalledOnce();
  });

  it("ignores an old worker reply after the registration moves to another build", async () => {
    const oldWorker = createWorker("old-worker");
    const registration = installRegistration(oldWorker);
    oldWorker.postMessage.mockImplementation((_message, ports) => {
      registration.active = createWorker() as unknown as ServiceWorker;
      ports[0]?.postMessage({ type: "sw-updated", version: "old-worker" });
    });
    await expect(refreshControlUiServiceWorker()).resolves.toBe(false);
    expect(scheduleStaleChunkReload).not.toHaveBeenCalled();
  });

  it("recovers the active build even when the network update check fails", async () => {
    const registration = installRegistration(createWorker("already-active-build"));
    registration.update.mockRejectedValue(new Error("worker update unavailable"));
    await expect(refreshControlUiServiceWorker()).resolves.toBe(true);
    expect(scheduleStaleChunkReload).toHaveBeenCalledOnce();
  });

  it("bounds unanswered identity queries without holding reconnect work", async () => {
    vi.useFakeTimers();
    let diagnostic: string | undefined;
    try {
      const worker = createWorker();
      worker.postMessage.mockImplementation(() => undefined);
      const registration = installRegistration(worker);
      const refresh = refreshControlUiServiceWorker();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(refresh).resolves.toBe(false);
      expect(registration.update).toHaveBeenCalledOnce();
      expect(scheduleStaleChunkReload).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } catch (error) {
      // Temporary evidence only: these are private fields of the pinned Vitest/Sinon clock.
      type ClockEntry = {
        type?: string;
        delay?: number;
        interval?: number;
        createdAt?: number;
        callAt?: number;
        func?: unknown;
      };
      const clock = (
        setTimeout as typeof setTimeout & {
          clock?: {
            now: number;
            methods: string[];
            timers?: Map<number, ClockEntry>;
            jobs?: ClockEntry[];
          };
        }
      ).clock;
      const callback = (value: unknown) =>
        typeof value === "function"
          ? { name: value.name, source: Function.prototype.toString.call(value).slice(0, 400) }
          : { type: typeof value };
      diagnostic = JSON.stringify(
        clock
          ? {
              now: clock.now,
              methods: clock.methods,
              timers: Array.from(clock.timers ?? [], ([id, timer]) => ({
                id,
                type: timer.type,
                delay: timer.delay,
                interval: timer.interval,
                createdAt: timer.createdAt,
                callAt: timer.callAt,
                callback: callback(timer.func),
              })),
              jobs: (clock.jobs ?? []).map((job, index) => ({
                index,
                callback: callback(job.func),
              })),
            }
          : { unavailable: "Pinned fake-clock introspection is unavailable" },
      );
      throw error;
    } finally {
      if (diagnostic) {
        vi.useRealTimers();
        console.error("[service-worker-clock-diagnostic]", diagnostic);
      }
    }
  });

  it("releases reconnect work when service workers are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(refreshControlUiServiceWorker()).resolves.toBe(false);
  });
});
