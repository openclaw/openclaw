import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { requestCloudWorkerStop } from "../components/cloud-worker-stop.runtime.ts";
import {
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";
import {
  createPlacementStartupHarness,
  createStartupPlacement,
  flushStartupMicrotasks,
} from "./session-placement-startup.test-support.ts";

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function restorePausedStartup(request: ReturnType<typeof vi.fn>) {
  const harness = createPlacementStartupHarness(request);
  expect(
    writeSessionPlacementRecovery({
      ...harness.input.recovery,
      phase: "paused",
      reason: "not-sent",
      error: "session placement reconciliation timed out",
    }),
  ).toBe(true);
  harness.startup.resumeRecovery();
  await flushStartupMicrotasks();
  expect(harness.startup.get(harness.input.recovery.sessionKey)?.action).toBe("retry");
  return harness;
}

describe("initial turn Retry after slow placement recovery", () => {
  it("reuses a worker that becomes active after recovery times out and sends only once", async () => {
    vi.useFakeTimers();
    let placement = createStartupPlacement("provisioning", 1);
    const request = vi.fn(async (method: string, params?: { idempotencyKey?: string }) => {
      if (method === "sessions.describe") {
        return { session: { sessionId: "session-startup", placement } };
      }
      if (method === "sessions.dispatch") {
        // The Gateway rejects redispatch once an existing placement is active.
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: `session cannot dispatch from placement ${placement.state}`,
        });
      }
      if (method === "sessions.send") {
        return { status: "started", runId: params?.idempotencyKey };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const { startup, input, chatSubmissions, client } = createPlacementStartupHarness(request, {
      recoveryBeforeStartup: true,
    });
    const { sessionKey, gatewayUrl, recoveryScope, messageId } = input.recovery;
    try {
      startup.resumeRecovery();
      await vi.runAllTimersAsync();
      expect(startup.get(sessionKey)).toMatchObject({
        phase: "failed",
        action: "retry",
        error: "session placement reconciliation timed out",
        initialTurn: { text: input.recovery.message, sendRunId: messageId },
      });
      expect(readSessionPlacementRecovery(gatewayUrl, recoveryScope, sessionKey)).toMatchObject({
        phase: "paused",
        reason: "not-sent",
        messageId,
      });
      expect(request.mock.calls.some(([method]) => method === "sessions.reclaim")).toBe(false);

      placement = createStartupPlacement("active", 2);
      startup.retry(sessionKey);
      startup.retry(sessionKey);
      await vi.runAllTimersAsync();

      expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toEqual([
        [
          "sessions.send",
          expect.objectContaining({
            key: sessionKey,
            message: input.recovery.message,
            idempotencyKey: messageId,
          }),
        ],
      ]);
      expect(request.mock.calls.some(([method]) => method === "sessions.dispatch")).toBe(false);
      expect(startup.get(sessionKey)).toBeNull();
      expect(readSessionPlacementRecovery(gatewayUrl, recoveryScope, sessionKey)).toBeNull();
      expect(chatSubmissions.readInitial(sessionKey, client)).not.toBeNull();
    } finally {
      startup.dispose();
    }
  });

  it.each(["requested", "provisioning", "syncing", "starting", "draining", "reconciling"])(
    "waits for an existing %s placement without allocating another worker",
    async (state) => {
      vi.useFakeTimers();
      let placement = createStartupPlacement(state, 1);
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.describe") {
          return { session: { placement } };
        }
        if (method === "sessions.send") {
          return { status: "started" };
        }
        throw new Error(`Unexpected ${method}`);
      });
      const { startup, input } = await restorePausedStartup(request);
      try {
        startup.retry(input.recovery.sessionKey);
        await flushStartupMicrotasks();
        expect(request.mock.calls.map(([method]) => method)).toEqual(["sessions.describe"]);
        placement = createStartupPlacement("active", 2);
        await vi.runAllTimersAsync();
        expect(request.mock.calls.filter(([method]) => method === "sessions.send")).toHaveLength(1);
        expect(request.mock.calls.some(([method]) => method === "sessions.dispatch")).toBe(false);
        expect(startup.get(input.recovery.sessionKey)).toBeNull();
      } finally {
        startup.dispose();
      }
    },
  );

  it.each([
    { state: undefined, released: true },
    { state: "local", released: true },
    { state: "reclaimed", released: true },
    { state: "failed", released: true },
    { state: "failed", released: false },
  ])(
    "redispatches $state only with Gateway admission (released: $released)",
    async ({ state, released }) => {
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.describe") {
          return { session: { placement: state ? createStartupPlacement(state, 1) : undefined } };
        }
        if (method === "sessions.dispatch") {
          if (!released) {
            throw new GatewayRequestError({
              code: "INVALID_REQUEST",
              message:
                "cloud worker environment must be stopped before redispatch; use Stop cloud worker",
            });
          }
          return { placement: createStartupPlacement("active", 2) };
        }
        if (method === "sessions.send") {
          return { status: "started" };
        }
        throw new Error(`Unexpected ${method}`);
      });
      const { startup, input } = await restorePausedStartup(request);
      try {
        startup.retry(input.recovery.sessionKey);
        startup.retry(input.recovery.sessionKey);
        await vi.waitFor(() => {
          if (released) {
            expect(startup.get(input.recovery.sessionKey)).toBeNull();
          } else {
            expect(startup.get(input.recovery.sessionKey)).toMatchObject({
              phase: "failed",
              error:
                "cloud worker environment must be stopped before redispatch; use Stop cloud worker",
            });
          }
        });
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "sessions.describe",
          "sessions.dispatch",
          ...(released ? ["sessions.send"] : []),
        ]);
      } finally {
        startup.dispose();
      }
    },
  );

  it("retires a removed session without recreating it", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.describe") {
        return { session: null };
      }
      throw new Error(`Unexpected ${method}`);
    });
    const { startup, input } = await restorePausedStartup(request);
    try {
      startup.retry(input.recovery.sessionKey);
      await vi.waitFor(() => expect(startup.get(input.recovery.sessionKey)).toBeNull());
      expect(request.mock.calls.map(([method]) => method)).toEqual(["sessions.describe"]);
      expect(sessionStorage.length).toBe(0);
    } finally {
      startup.dispose();
    }
  });

  it.each([undefined, "reclaimed", "failed"])(
    "does not allocate during passive recovery of %s placement",
    async (state) => {
      vi.useFakeTimers();
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.describe") {
          return { session: { placement: state ? createStartupPlacement(state, 1) : undefined } };
        }
        if (method === "sessions.reclaim") {
          return { ok: true };
        }
        throw new Error(`Unexpected ${method}`);
      });
      const { startup, input } = createPlacementStartupHarness(request, {
        recoveryBeforeStartup: true,
      });
      try {
        startup.resumeRecovery();
        await vi.runAllTimersAsync();
        expect(startup.get(input.recovery.sessionKey)?.action).toBe("retry");
        expect(
          request.mock.calls.every(
            ([method]) => method === "sessions.describe" || method === "sessions.reclaim",
          ),
        ).toBe(true);
      } finally {
        startup.dispose();
      }
    },
  );

  it.each(["active", "reclaimed"])(
    "Stop fences a late %s read during Retry before any send or dispatch",
    async (state) => {
      const description = createDeferred<unknown>();
      const request = vi.fn(async (method: string) => {
        if (method === "sessions.describe") {
          return description.promise;
        }
        if (method === "sessions.reclaim") {
          return { ok: true };
        }
        throw new Error(`Unexpected ${method}`);
      });
      const { startup, input, gateway } = await restorePausedStartup(request);
      const client = gateway.snapshot.client;
      if (!client) {
        throw new Error("Expected the startup fixture client");
      }
      try {
        startup.retry(input.recovery.sessionKey);
        await flushStartupMicrotasks();
        await requestCloudWorkerStop(client, { key: input.recovery.sessionKey }, startup);
        description.resolve({ session: { placement: createStartupPlacement(state, 2) } });
        await flushStartupMicrotasks();
        expect(startup.get(input.recovery.sessionKey)).toMatchObject({
          phase: "failed",
          action: "retry",
          initialTurn: { sendRunId: input.recovery.messageId },
        });
        expect(request.mock.calls.map(([method]) => method)).toEqual([
          "sessions.describe",
          "sessions.reclaim",
        ]);
      } finally {
        description.resolve({ session: null });
        startup.dispose();
      }
    },
  );
});
