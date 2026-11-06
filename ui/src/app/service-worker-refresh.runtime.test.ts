/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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

function createWorker(
  version = CONTROL_UI_BUILD_INFO.buildId,
  state: ServiceWorkerState = "activated",
) {
  return Object.assign(new EventTarget(), {
    state,
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
  it.each([
    { saveData: true, effectiveType: "4g" },
    { saveData: false, effectiveType: "2g" },
  ])("sends browser download preferences with the worker probe: %j", async (connection) => {
    const worker = createWorker();
    installRegistration(worker);
    Object.assign(navigator, { connection: Object.assign(new EventTarget(), connection) });
    await refreshControlUiServiceWorker();
    expect(worker.postMessage).toHaveBeenCalledWith(
      { type: "sw-version-probe", offlinePrecache: connection },
      expect.any(Array),
    );
  });
  it.each(["lookup", "update", "installing"] as const)(
    "releases reconnect after a stalled %s and ignores late completion",
    async (phase) => {
      vi.useFakeTimers();
      const replacement = createWorker("replacement", "installing");
      const registration = installRegistration();
      const stalled = createDeferred<undefined>();
      let complete = () => stalled.resolve(undefined);
      if (phase === "lookup") {
        vi.stubGlobal("navigator", {
          serviceWorker: {
            getRegistration: async () => {
              await stalled.promise;
              return registration;
            },
          },
        });
      } else if (phase === "update") {
        registration.update.mockImplementation(() => stalled.promise);
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
  it("updates download policy on connection changes without an update check or duplicate listeners", async () => {
    const worker = createWorker();
    const registration = installRegistration(worker);
    const connection = Object.assign(new EventTarget(), { saveData: false, effectiveType: "2g" });
    Object.assign(navigator, { connection });
    await refreshControlUiServiceWorker();
    await refreshControlUiServiceWorker();
    worker.postMessage.mockClear();
    for (const preferences of [
      { saveData: false, effectiveType: "4g" },
      { saveData: true, effectiveType: "4g" },
      { saveData: false, effectiveType: "2g" },
    ]) {
      Object.assign(connection, preferences);
      connection.dispatchEvent(new Event("change"));
      expect(worker.postMessage).toHaveBeenLastCalledWith(
        { type: "sw-version-probe", offlinePrecache: preferences },
        [],
      );
    }
    expect(worker.postMessage).toHaveBeenCalledTimes(3);
    expect(registration.update).toHaveBeenCalledTimes(2);
  });
  it("recovers a document that missed the active worker's activation", async () => {
    const active = createWorker("already-active-build");
    const registration = installRegistration(active);
    // No second activation: the same worker already claimed this sleeping page.
    await expect(refreshControlUiServiceWorker()).resolves.toBe(true);
    expect(scheduleStaleChunkReload).toHaveBeenCalledOnce();
    expect(registration.update).toHaveBeenCalledOnce();
  });

  it.each([
    ["discovered", "next-build"],
    ["installing", "next-build"],
    ["waiting", "next-build"],
    ["installing", CONTROL_UI_BUILD_INFO.buildId],
  ] as const)(
    "holds reconnect work until a %s replacement identifies build %s",
    async (phase, version) => {
      const ownBuild = version === CONTROL_UI_BUILD_INFO.buildId;
      const replacement = createWorker(version, "installing");
      const registration = installRegistration(
        createWorker(ownBuild ? "previous-build" : undefined),
      );
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
      await expect(refresh).resolves.toBe(!ownBuild);
      if (ownBuild) {
        expect(scheduleStaleChunkReload).not.toHaveBeenCalled();
      }
    },
  );

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
    const worker = createWorker();
    worker.postMessage.mockImplementation(() => undefined);
    const registration = installRegistration(worker);
    const refresh = refreshControlUiServiceWorker();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(refresh).resolves.toBe(false);
    expect(registration.update).toHaveBeenCalledOnce();
    expect(scheduleStaleChunkReload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases reconnect work when service workers are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(refreshControlUiServiceWorker()).resolves.toBe(false);
  });
});
