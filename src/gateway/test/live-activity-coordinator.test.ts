import { EventEmitter } from "node:events";
import http2 from "node:http2";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  loadExactSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as apns from "../../infra/push-apns.js";
import { createLiveActivityCoordinator } from "../live-activity-coordinator.js";
import {
  ACTIVITY_EPOCH,
  activityAuth,
  activityDirect,
  activityRelay,
  readActivityRequestBody,
  withLiveActivityFixture,
} from "../live-activity.test-support.js";

function http2Boundary(status: number, reason?: string) {
  const requests: Array<{ headers: http2.OutgoingHttpHeaders; body: string }> = [];
  const session = Object.assign(new EventEmitter(), {
    close: vi.fn(),
    destroy: vi.fn(),
    request: vi.fn((headers: http2.OutgoingHttpHeaders) => {
      const stream = Object.assign(new EventEmitter(), {
        destroyed: false,
        setTimeout: vi.fn(),
        close: vi.fn(),
        end: (body: string) => {
          requests.push({ headers, body });
          queueMicrotask(() => {
            stream.emit("response", { ":status": status });
            if (reason) {
              stream.emit("data", JSON.stringify({ reason }));
            }
            stream.emit("end");
          });
        },
      });
      stream.close.mockImplementation(() => {
        stream.destroyed = true;
        stream.emit("close");
      });
      return stream;
    }),
  });
  session.close.mockImplementation(() => session.emit("close"));
  session.destroy.mockImplementation(() => session.emit("close"));
  vi.spyOn(http2, "connect").mockReturnValue(session as unknown as http2.ClientHttp2Session);
  return { session, requests };
}

it.each([
  { status: 409, reason: undefined, retired: false },
  { status: 409, reason: "ActivityBusy", retired: false },
  { status: 409, reason: "ActivityAdmissionStale", retired: false },
  { status: 409, reason: "ActivityTerminalConflict", retired: true },
  { status: 410, reason: undefined, retired: true },
  { status: 401, reason: "unauthorized", retired: false },
  { status: 403, reason: "InvalidProviderToken", retired: false },
  { status: 429, reason: "rate_limited", retired: false },
])("classifies actual relay HTTP $status/$reason without broad 4xx retirement", async (outcome) => {
  await withLiveActivityFixture(async (f) => {
    vi.mocked(fetch).mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            status: "conflict",
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          }),
          { status: outcome.status },
        ),
    );
    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    const registered = await f.register();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    expect(f.coordinator.store.load(registered.registrationId)?.state).toBe(
      outcome.retired ? "tombstone" : "active",
    );
    expect(f.log.warn).toHaveBeenCalledTimes(outcome.reason === "ActivityTerminalConflict" ? 1 : 0);
    if (!outcome.retired) {
      const firstBody = vi.mocked(fetch).mock.calls[0]?.[1]?.body;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(vi.mocked(fetch).mock.calls[1]?.[1]?.body).toBe(firstBody);
    }
  });
});

it.each([
  { status: 400, reason: "BadDeviceToken", retired: true },
  { status: 400, reason: "BadTopic", retired: false },
  { status: 403, reason: "ExpiredProviderToken", retired: false },
  { status: 410, reason: "Unregistered", retired: true },
])(
  "classifies direct HTTP/2 $status/$reason at the activity destination boundary",
  async (outcome) => {
    await withLiveActivityFixture(async (f) => {
      vi.spyOn(apns, "resolveApnsAuthConfigFromEnv").mockResolvedValue({
        ok: true,
        value: activityAuth,
      });
      const boundary = http2Boundary(outcome.status, outcome.reason);
      await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
      const registered = await f.register(activityDirect);
      await vi.advanceTimersByTimeAsync(0);
      expect(boundary.requests).toHaveLength(1);
      expect(boundary.requests[0]?.headers).toMatchObject({
        "apns-topic": "ai.openclaw.ios.push-type.liveactivity",
        "apns-push-type": "liveactivity",
        "apns-priority": "5",
      });
      expect(f.coordinator.store.load(registered.registrationId)?.state).toBe(
        outcome.retired ? "tombstone" : "active",
      );
    });
  },
);

it.each(["disconnect", "admission closed", "producer aborted", "Gateway closing"] as const)(
  "rechecks direct dispatch after awaited auth: %s",
  async (change) => {
    await withLiveActivityFixture(async (f) => {
      const entered = createDeferred();
      const auth = createDeferred<Awaited<ReturnType<typeof apns.resolveApnsAuthConfigFromEnv>>>();
      vi.spyOn(apns, "resolveApnsAuthConfigFromEnv")
        .mockResolvedValueOnce({ ok: true, value: activityAuth })
        .mockImplementationOnce(() => {
          entered.resolve();
          return auth.promise;
        });
      const boundary = http2Boundary(200);
      await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
      await f.register(activityDirect);
      await entered.promise;
      try {
        expect(boundary.session.request).not.toHaveBeenCalled();
        if (change === "disconnect") {
          f.disconnect();
        } else if (change === "admission closed") {
          f.closeAdmission();
        } else if (change === "producer aborted") {
          f.entry.controller.abort();
        } else {
          f.coordinator.beginClose();
        }
        auth.resolve({ ok: true, value: activityAuth });
        await vi.advanceTimersByTimeAsync(0);
        expect(boundary.requests).toHaveLength(change === "disconnect" ? 1 : 0);
      } finally {
        auth.resolve({ ok: true, value: activityAuth });
      }
    });
  },
);

it("coalesces progress and preserves an accepted terminal after cleanup and a successor", async () => {
  await withLiveActivityFixture(async (f) => {
    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    const registered = await f.register();
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 4; index++) {
      await f.emit("tool", { phase: index % 2 === 0 ? "start" : "result", name: "must-not-leak" });
    }
    expect(fetch).toHaveBeenCalledOnce();
    expect(f.coordinator.store.load(registered.registrationId)?.snapshot?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(1_000);
    const terminal = f.emit("lifecycle", { phase: "end", endedAt: Date.now() });
    f.chatAbortControllers.clear();
    await terminal;
    await upsertSessionEntryCore(f.session, {
      sessionId: f.entry.sessionId,
      lifecycleRevision: f.entry.preparedSession!.lifecycleRevision ?? undefined,
      updatedAt: Date.now(),
      status: "running",
      lifecycleRunId: "successor",
      lastRunId: undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    const body = JSON.parse(readActivityRequestBody(vi.mocked(fetch).mock.calls[1]?.[1]));
    expect(body).toMatchObject({
      purpose: "liveActivity",
      priority: 10,
      payload: { aps: { event: "end", "content-state": { status: "completed" } } },
    });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
    expect(f.coordinator.store.load(registered.registrationId)?.state).toBe("tombstone");
  });
});

it("ignores obsolete relay outcomes after rotation and sends only the current revision", async () => {
  await withLiveActivityFixture(async (f) => {
    const sent = createDeferred();
    const response = createDeferred<Response>();
    vi.mocked(fetch).mockImplementationOnce(() => {
      sent.resolve();
      return response.promise;
    });
    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    const registered = await f.register();
    await sent.promise;
    try {
      const rotated = await f.rpc("push.liveActivity.rotate", {
        registrationId: registered.registrationId,
        expectedRevision: registered.rotationRevision,
        destination: { ...activityRelay, relayHandle: "rotated-handle", relayRevision: 2 },
      });
      expect(rotated[0]).toBe(true);
      response.resolve(
        new Response(JSON.stringify({ reason: "ActivityTerminalConflict" }), { status: 409 }),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.coordinator.store.load(registered.registrationId)).toMatchObject({
        state: "active",
        rotationRevision: 2,
      });
      expect(f.log.warn).not.toHaveBeenCalled();
      expect(
        JSON.parse(readActivityRequestBody(vi.mocked(fetch).mock.calls[1]?.[1])),
      ).toMatchObject({
        relayHandle: "rotated-handle",
        revision: 2,
      });
    } finally {
      response.resolve(new Response("{}", { status: 200 }));
    }
  });
});

it("expires offline leases without a new event and never restores progress authority on restart", async () => {
  await withLiveActivityFixture(async (f) => {
    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    const registered = await f.register();
    await vi.advanceTimersByTimeAsync(0);
    f.disconnect();
    await vi.advanceTimersByTimeAsync(8 * 3_600_000);
    expect(f.coordinator.store.load(registered.registrationId)?.state).toBe("tombstone");
    expect(fetch).toHaveBeenCalledOnce();
  });
  await withLiveActivityFixture(async (f) => {
    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    const registered = await f.register();
    await f.coordinator.stop();
    vi.mocked(fetch).mockClear();
    const recovered = createLiveActivityCoordinator({
      gatewayIdentity: f.gatewayIdentity,
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => f.cfg,
      log: f.log,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(recovered.store.load(registered.registrationId)?.state).toBe("tombstone");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await recovered.stop();
    }
  });
});

it("does not publish a terminal when the canonical write is a truthy no-op", async () => {
  await withLiveActivityFixture(async (f) => {
    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    const registered = await f.register();
    await vi.advanceTimersByTimeAsync(1_000);
    await upsertSessionEntryCore(f.session, {
      sessionId: f.entry.sessionId,
      updatedAt: Date.now(),
      startedAt: Date.now(),
      status: "running",
      lifecycleRunId: "successor",
    });
    await f.emit("lifecycle", {
      phase: "end",
      startedAt: ACTIVITY_EPOCH,
      endedAt: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(loadExactSessionEntryReadOnly(f.session)?.entry).toMatchObject({
      lifecycleRunId: "successor",
      status: "running",
    });
    expect(f.coordinator.store.load(registered.registrationId)?.snapshot?.status).toBe("running");
    expect(fetch).toHaveBeenCalledOnce();
  });
});

it("preserves a canonical commit when the activity sink throws", async () => {
  await withLiveActivityFixture(async (f) => {
    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    vi.spyOn(f.coordinator, "observe").mockImplementationOnce(() => {
      throw new Error("sensitive sink detail");
    });
    await expect(
      f.emit("lifecycle", {
        phase: "end",
        endedAt: ACTIVITY_EPOCH,
      }),
    ).resolves.toBeUndefined();
    expect(loadExactSessionEntryReadOnly(f.session)?.entry.status).toBe("done");
  });
});

it("accepts canonical terminals during drain but fences dispatch and resumes only their stored bytes", async () => {
  await withLiveActivityFixture(async (f) => {
    await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
    const registered = await f.register();
    await vi.advanceTimersByTimeAsync(1_000);
    f.coordinator.beginClose();
    vi.mocked(fetch).mockClear();
    await f.emit("lifecycle", { phase: "end", endedAt: Date.now() });
    expect(f.coordinator.store.load(registered.registrationId)).toMatchObject({
      state: "terminal_pending",
      snapshot: { status: "done", observedAtMs: ACTIVITY_EPOCH + 1_000 },
    });
    expect(fetch).not.toHaveBeenCalled();
    await f.coordinator.stop();
    const recovered = createLiveActivityCoordinator({
      gatewayIdentity: f.gatewayIdentity,
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => f.cfg,
      log: f.log,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledOnce();
      expect(recovered.store.load(registered.registrationId)?.state).toBe("tombstone");
    } finally {
      await recovered.stop();
    }
  });
});

it("bounds concurrent delivery and wakes a waiting registration when a slot settles", async () => {
  await withLiveActivityFixture(async (f) => {
    const responses: Array<ReturnType<typeof createDeferred<Response>>> = [];
    vi.mocked(fetch).mockImplementation(() => {
      const response = createDeferred<Response>();
      responses.push(response);
      return response.promise;
    });
    try {
      await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
      for (let index = 0; index < 5; index++) {
        await f.register(activityRelay, undefined, `concurrent-${index}`);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(4);
      responses[0]!.resolve(new Response("{}", { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(5);
    } finally {
      vi.mocked(fetch).mockImplementation(async () => new Response("{}", { status: 200 }));
      for (const response of responses) {
        response.resolve(new Response("{}", { status: 200 }));
      }
      await vi.advanceTimersByTimeAsync(0);
    }
  });
});

it.each(["deadline", "shutdown"] as const)(
  "aborts and joins owned fetch on %s",
  async (closure) => {
    await withLiveActivityFixture(async (f) => {
      const sent = createDeferred<AbortSignal>();
      vi.mocked(fetch).mockImplementationOnce(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              throw new Error("Activity delivery requires cancellation");
            }
            sent.resolve(signal);
            signal.addEventListener(
              "abort",
              () => {
                const reason = signal.reason;
                reject(
                  reason instanceof Error
                    ? reason
                    : new Error("Activity delivery aborted", { cause: reason }),
                );
              },
              { once: true },
            );
          }),
      );
      await f.emit("lifecycle", { phase: "start", startedAt: ACTIVITY_EPOCH });
      await f.register();
      const signal = await sent.promise;
      expect(signal.aborted).toBe(false);
      if (closure === "shutdown") {
        await f.coordinator.stop();
        expect(fetch).toHaveBeenCalledOnce();
      } else {
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(signal.aborted).toBe(true);
    });
  },
);
