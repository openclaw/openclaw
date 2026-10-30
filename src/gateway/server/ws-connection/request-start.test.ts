import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { GatewayRequestStartTimeoutError, scheduleGatewayRequestStart } from "./request-start.js";

const permissions: Promise<void>[] = [];
const releases: (() => void)[] = [];
function heldCompletion() {
  const completion = createDeferredCore();
  releases.push(completion.resolve);
  return completion;
}
const workRequest = { method: "chat.send" };
const subscribeRequest = { method: "sessions.messages.subscribe", params: { key: "session" } };
const independentReads = [
  "chat.history",
  "board.get",
  "sessions.resolve",
  "sessions.list",
  "cron.list",
  "push.web.vapidPublicKey",
  "sessions.github.options",
  "workboard.cards.list",
  "github.preview",
  "sessions.describe",
  "users.list",
  "agents.list",
  "agent.identity.get",
  "plugins.controlUi.list",
  "workboard.boards.list",
];
function requestStart(
  bytes = 1,
  request: Parameters<typeof scheduleGatewayRequestStart>[1] = workRequest,
  connId = "connection",
  settled = Promise.resolve(),
  signal?: AbortSignal,
): Promise<void> {
  const permission = scheduleGatewayRequestStart(bytes, request, connId, settled, signal);
  if (!permission) {
    throw new Error("expected start capacity");
  }
  permissions.push(permission);
  return permission;
}

function holdPreparations(
  request: Parameters<typeof scheduleGatewayRequestStart>[1] = { method: "models.list" },
) {
  const held = Array.from({ length: 4 }, heldCompletion);
  return {
    held,
    start: () =>
      Promise.all(
        held.map((completion, index) =>
          requestStart(100, request, `held-${index}`, completion.promise),
        ),
      ),
  };
}

function recordStarts(label = (method: string, _connId: string) => method) {
  const starts: string[] = [];
  const start = (method: string, connId = "viewer", params: unknown = {}) =>
    requestStart(100, { method, params }, connId).then(() => {
      starts.push(label(method, connId));
    });
  return { starts, start };
}

afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  vi.useRealTimers();
  await Promise.all(permissions.splice(0));
  vi.restoreAllMocks();
});

describe("Gateway request start fairness", () => {
  it("bounds concurrent reconnect preparations through settlement and yields before each start", async () => {
    const methods = [
      { method: "sessions.subscribe", params: { limit: 100 } },
      { method: "models.list" },
      { method: "sessions.messages.subscribe", params: { includeApprovals: true } },
      { method: "sessions.messages.subscribe", params: { initialHistory: {} } },
    ];
    const completions = Array.from({ length: 8 }, heldCompletion);
    const full = createDeferredCore();
    const fifth = createDeferredCore();
    const events: string[] = [];
    completions.forEach((completion, index) => {
      const permission = requestStart(
        100,
        methods[index % methods.length]!,
        `reconnect-${index}`,
        completion.promise,
      );
      permissions.push(
        permission.then(() => {
          events.push(`start-${index}`);
          if (index === 0) {
            void nextTurn().then(() => events.push("socket I/O"));
          }
          if (index === 3) {
            void nextTurn().then(full.resolve);
          }
          if (index === 4) {
            fifth.resolve();
          }
        }),
      );
    });
    await full.promise;
    expect(events).toEqual(["start-0", "socket I/O", "start-1", "start-2", "start-3"]);
    completions[0]!.resolve();
    await fifth.promise;
    expect(events.at(-1)).toBe("start-4");
  });

  it("parks preparations without blocking reads or reordering connection mutations", async () => {
    const { held, start: startHeld } = holdPreparations();
    const { starts, start } = recordStarts();
    await startHeld();
    const subscription = start("sessions.messages.subscribe", "viewer", {
      key: "main",
      includeApprovals: true,
    });
    const unsubscribe = start("sessions.messages.unsubscribe", "viewer", { key: "main" });
    const mutation = start("chat.send", "viewer");
    for (const method of independentReads) {
      void start(method, "viewer");
    }
    void start("sessions.create", "another-viewer");
    await nextTurn();
    expect(starts).toEqual([...independentReads, "sessions.create"]);
    held[0]!.resolve();
    await Promise.all([subscription, unsubscribe, mutation]);
    expect(starts.slice(independentReads.length + 1)).toEqual([
      "sessions.messages.subscribe",
      "sessions.messages.unsubscribe",
      "chat.send",
    ]);
  });

  it("starts event-only roster subscriptions while snapshot preparation is saturated", async () => {
    const { held, start } = holdPreparations();
    await start();
    const { starts, start: record } = recordStarts((_method, connId) => connId);
    const eventOnly = record("sessions.subscribe", "events");
    const messageBodies = record("sessions.subscribe", "bodies", { includeMessageBodies: true });
    const snapshot = record("sessions.subscribe", "snapshot", { limit: 100 });
    await nextTurn();
    expect(starts).toEqual(["events", "bodies"]);
    held[0]!.resolve();
    await Promise.all([eventOnly, messageBodies, snapshot]);
    expect(starts.at(-1)).toBe("snapshot");
  });

  it("keeps a parked catalog read from blocking later connection work", async () => {
    const { held, start } = holdPreparations();
    await start();
    const { starts, start: record } = recordStarts();
    const requests = [
      { method: "models.list" },
      { method: "sessions.subscribe", params: {} },
      subscribeRequest,
      { method: "sessions.messages.unsubscribe", params: { key: "session" } },
      workRequest,
    ].map((request) => record(request.method, "viewer", "params" in request ? request.params : {}));
    await nextTurn();
    expect(starts).toEqual([
      "sessions.subscribe",
      "sessions.messages.subscribe",
      "sessions.messages.unsubscribe",
      "chat.send",
    ]);
    held[0]!.resolve();
    await Promise.all(requests);
    expect(starts.at(-1)).toBe("models.list");
  });

  it("prioritizes lifecycle starts while preserving same-connection mutation order", async () => {
    const { held, start: startHeld } = holdPreparations();
    const events: string[] = [];
    const start = (method: string, connId: string, params = {}) =>
      requestStart(100, { method, params }, connId).then(() => events.push(`${connId}:${method}`));
    await startHeld();
    // The parked preparation wakes the queue, but unrelated lifecycle starts
    // must reach their handlers before the ordinary backlog resumes.
    const parked = start("sessions.subscribe", "blocked", { limit: 100 });
    const mutation = start("chat.send", "blocked");
    const resume = start("gateway.suspend.resume", "blocked");
    const ordinary = start("chat.send", "ordinary");
    const status = start("gateway.suspend.status", "blocked");
    const update = start("update.status", "operator");
    const handoff = start("gateway.suspend.handoff", "operator");
    await nextTurn();
    expect(events).toEqual([
      "blocked:gateway.suspend.status",
      "operator:update.status",
      "operator:gateway.suspend.handoff",
      "ordinary:chat.send",
    ]);
    held[0]!.resolve();
    await Promise.all([parked, mutation, resume, status, update, handoff, ordinary]);
    expect(events.slice(4)).toEqual([
      "blocked:sessions.subscribe",
      "blocked:chat.send",
      "blocked:gateway.suspend.resume",
    ]);
  });

  it("releases a cancelled preparation waiter while earlier requests still own capacity", async () => {
    const { held, start } = holdPreparations({
      method: "sessions.subscribe",
      params: { limit: 100 },
    });
    const started = start();
    const controller = new AbortController();
    const cancelled = scheduleGatewayRequestStart(
      100,
      { method: "sessions.subscribe", params: { limit: 100 } },
      "cancelled",
      Promise.resolve(),
      controller.signal,
    );
    await started;
    controller.abort();
    await expect(cancelled).resolves.toBeUndefined();
    held.forEach((completion) => completion.resolve());
    await started;
    await expect(requestStart()).resolves.toBeUndefined();
  });

  it("expires a parked start without releasing active preparation capacity", async () => {
    const { held, start } = holdPreparations();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const request = { method: "models.list" };
    await start();
    const waiting = scheduleGatewayRequestStart(100, request, "waiting", Promise.resolve());
    const rejected = expect(waiting).rejects.toBeInstanceOf(GatewayRequestStartTimeoutError);
    await nextTurn();
    now = 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    const later = requestStart(100, request, "later");
    let started = false;
    void later.then(() => {
      started = true;
    });
    await nextTurn();
    expect(started).toBe(false);
    held[0]!.resolve();
    await later;
  });

  it.each(["settled", "cancelled"] as const)(
    "bounds settlement listeners while sibling requests are %s",
    async (outcome) => {
      const held = heldCompletion();
      const observeSettlement = vi.spyOn(held.promise, "then");
      const siblings = Array.from({ length: 3 }, heldCompletion);
      const request = { method: "models.list" };
      const start = (settled: Promise<void>, signal?: AbortSignal) => {
        return requestStart(100, request, "client", settled, signal);
      };
      await Promise.all([
        start(held.promise),
        ...siblings.map((sibling) => start(sibling.promise)),
      ]);
      for (let index = 0; index < 32; index++) {
        const completion = heldCompletion();
        const controller = new AbortController();
        const permission = start(completion.promise, controller.signal);
        await nextTurn();
        if (outcome === "cancelled") {
          controller.abort();
          completion.resolve();
        } else {
          const slot = index % siblings.length;
          siblings[slot]!.resolve();
          siblings[slot] = completion;
        }
        await permission;
      }
      expect(observeSettlement.mock.calls.length).toBeLessThanOrEqual(4);
    },
  );

  it.each([false, true])(
    "yields after actual caller work (ready continuation: %s)",
    async (continuation) => {
      let workClock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => workClock);
      const events: string[] = [];
      let sentinel: Promise<void> | undefined;
      const first = requestStart().then(async () => {
        if (continuation) {
          await Promise.resolve();
        }
        events.push("first");
        workClock += 20;
        sentinel = nextTurn().then(() => {
          events.push("yield");
        });
      });
      const second = requestStart().then(() => {
        events.push("second");
      });
      await Promise.all([first, second]);
      await sentinel;
      expect(events).toEqual(["first", "yield", "second"]);
    },
  );

  it("shares the per-turn start limit across work and controls even when elapsed work stays zero", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const starts: number[] = [];
    let seenAtYield: number | undefined;
    let sentinel: Promise<void> | undefined;
    const callers = Array.from({ length: 65 }, (_, index) =>
      requestStart(1, index % 2 ? subscribeRequest : workRequest, `client-${index}`).then(() => {
        starts.push(index);
        if (index === 0) {
          sentinel = nextTurn().then(() => {
            seenAtYield = starts.length;
          });
        }
      }),
    );
    await Promise.all(callers);
    await sentinel;
    expect(seenAtYield).toBe(64);
    expect(starts).toEqual(Array.from({ length: 65 }, (_, index) => index));
  });

  it.each([
    { kind: "work", count: 256, bytes: 1, request: workRequest, overflow: workRequest },
    {
      kind: "control",
      count: 16,
      bytes: 180,
      request: { method: "sessions.messages.unsubscribe", params: { key: "session" } },
      overflow: subscribeRequest,
    },
  ])(
    "bounds one connection's $kind queue without consuming another connection's capacity",
    async ({ count, bytes, request, overflow }) => {
      vi.spyOn(performance, "now").mockReturnValue(0);
      const active = requestStart();
      const accepted = Array.from({ length: count }, () => requestStart(bytes, request));
      expect(
        scheduleGatewayRequestStart(bytes, overflow, "connection", Promise.resolve()),
      ).toBeNull();
      const other = requestStart(bytes, overflow, "another-connection");
      await Promise.all([active, ...accepted, other]);
      await expect(requestStart(bytes, overflow)).resolves.toBeUndefined();
    },
  );

  it("reserves subscription capacity while preserving FIFO order and work limits", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const starts: number[] = [];
    const work = Array.from({ length: 1025 }, (_, index) =>
      requestStart(1, workRequest, `work-${index % 4}`).then(() => starts.push(index)),
    );
    const controls = Array.from({ length: 600 }, (_, index) =>
      requestStart(180, subscribeRequest, `client-${Math.floor(index / 6)}`).then(() =>
        starts.push(index + work.length),
      ),
    );
    for (const [bytes, request] of [
      [1, workRequest],
      [1, { method: "sessions.subscribe" }],
      [1, { ...subscribeRequest, params: { key: "session", includeApprovals: true } }],
      [4097, subscribeRequest],
    ] as const) {
      expect(
        scheduleGatewayRequestStart(bytes, request, "another-client", Promise.resolve()),
      ).toBeNull();
    }
    await Promise.all([...work, ...controls]);
    expect(starts).toEqual(Array.from({ length: 1625 }, (_, index) => index));
    await expect(requestStart()).resolves.toBeUndefined();
  });

  it.each([
    { kind: "control frames", bytes: 1, count: 1024, request: subscribeRequest },
    { kind: "control bytes", bytes: 4096, count: 256, request: subscribeRequest },
    { kind: "work bytes", bytes: 25 * 1024 * 1024, count: 2, request: workRequest },
  ])(
    "bounds $kind waiting capacity at $count frames of $bytes bytes",
    async ({ bytes, count, request }) => {
      vi.spyOn(performance, "now").mockReturnValue(0);
      const active = requestStart(bytes, request);
      const queued = Array.from({ length: count }, (_, index) =>
        requestStart(bytes, request, `client-${index}`),
      );
      expect(scheduleGatewayRequestStart(bytes, request, "overflow", Promise.resolve())).toBeNull();
      if (request === workRequest) {
        expect(
          scheduleGatewayRequestStart(1, workRequest, "connection", Promise.resolve()),
        ).toBeNull();
      }
      const other = requestStart(1, request === subscribeRequest ? workRequest : subscribeRequest);
      await Promise.all([active, other, ...queued]);
      await expect(requestStart(bytes, request, "overflow")).resolves.toBeUndefined();
    },
  );
});
