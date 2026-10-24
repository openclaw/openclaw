import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { requestCloudWorkerStop } from "../components/cloud-worker-stop.runtime.ts";
import {
  createPlacementStartupHarness,
  createStartupPlacement,
  flushStartupMicrotasks,
} from "./session-placement-startup.test-support.ts";

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

it("cancels the client-owned first-send wait before reclaiming its worker", async () => {
  const sending = createDeferred<AbortSignal>();
  const request = vi.fn((method: string, _params: unknown, options?: { signal?: AbortSignal }) => {
    if (method === "sessions.dispatch") {
      return Promise.resolve({ placement: createStartupPlacement("active", 1) });
    }
    if (method === "sessions.send") {
      const signal = options?.signal;
      if (!signal) {
        throw new Error("initial send must have an owner cancellation signal");
      }
      sending.resolve(signal);
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("request aborted")), {
          once: true,
        });
      });
    }
    if (method === "sessions.reclaim") {
      expect(sendingSignal.aborted).toBe(true);
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({ messages: [] });
  });
  const { startup, input, gateway } = createPlacementStartupHarness(request);
  const client = gateway.snapshot.client;
  if (!client) {
    throw new Error("Expected the startup fixture client");
  }
  let sendingSignal: AbortSignal;
  try {
    startup.start(input);
    sendingSignal = await sending.promise;
    expect(sendingSignal.aborted).toBe(false);
    await requestCloudWorkerStop(client, { key: input.recovery.sessionKey }, startup);
    expect(sendingSignal.aborted).toBe(true);
    await flushStartupMicrotasks();
    expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(1);
  } finally {
    startup.dispose();
  }
});
