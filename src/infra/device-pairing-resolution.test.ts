import { afterEach, expect, it, vi } from "vitest";
import {
  publishDevicePairingResolution,
  refreshDevicePairingResolutionWaiters,
  waitForDevicePairingResolution,
} from "./device-pairing-resolution.js";

afterEach(() => vi.useRealTimers());

it("expires an unanswered wait rather than manufacturing a rejection and forgets closed connections", async () => {
  vi.useFakeTimers();
  const request = { requestId: "pending-request", deviceId: "pending-browser" };
  const controller = new AbortController();
  const wait = waitForDevicePairingResolution(request, {
    signal: controller.signal,
    expiresAtMs: Date.now() + 100,
  });
  publishDevicePairingResolution({ ...request, requestId: "different-request" }, "rejected");
  publishDevicePairingResolution({ ...request, deviceId: "different-browser" }, "rejected");
  await vi.advanceTimersByTimeAsync(100);
  await expect(wait).resolves.toBe("expired");
  expect(vi.getTimerCount()).toBe(0);

  const closed = waitForDevicePairingResolution(request, {
    signal: controller.signal,
    expiresAtMs: Date.now() + 100,
  });
  controller.abort();
  await expect(closed).resolves.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  publishDevicePairingResolution(request, "rejected");
  const fresh = waitForDevicePairingResolution(request, {
    signal: new AbortController().signal,
    expiresAtMs: Date.now() + 100,
  });
  await vi.advanceTimersByTimeAsync(100);
  await expect(fresh).resolves.toBe("expired");
});

it("keeps live waits aligned with the producer's refreshed pending deadline", async () => {
  vi.useFakeTimers();
  const request = { requestId: "refreshed-request", deviceId: "waiting-browser" };
  const wait = waitForDevicePairingResolution(request, {
    signal: new AbortController().signal,
    expiresAtMs: Date.now() + 100,
  });
  await vi.advanceTimersByTimeAsync(50);
  refreshDevicePairingResolutionWaiters(request, Date.now() + 100);
  await vi.advanceTimersByTimeAsync(75);
  publishDevicePairingResolution(request, "rejected");
  await expect(wait).resolves.toBe("rejected");
  expect(vi.getTimerCount()).toBe(0);
});
