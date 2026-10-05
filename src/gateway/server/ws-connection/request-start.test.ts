import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { createDeferredCore } from "../../../shared/deferred.js";
import { MAX_PAYLOAD_BYTES, MAX_PREAUTH_PAYLOAD_BYTES } from "../../server-constants.js";
import { prepareGatewayReceiverHandoff, raiseGatewayReceiverPayloadLimit } from "../ws-receiver.js";
import { scheduleGatewayRequestStart } from "./request-start.js";

const permissions: Promise<void>[] = [];
const workRequest = { method: "chat.send" };
const subscribeRequest = { method: "sessions.messages.subscribe", params: { key: "session" } };
function requestStart(bytes = 1, request = workRequest, connId = "connection"): Promise<void> {
  const permission = scheduleGatewayRequestStart(bytes, request, connId, Promise.resolve());
  if (!permission) {
    throw new Error("expected start capacity");
  }
  permissions.push(permission);
  return permission;
}

afterEach(async () => {
  await Promise.all(permissions.splice(0));
  vi.restoreAllMocks();
});

describe("Gateway request start fairness", () => {
  it("bounds concurrent reconnect preparations through settlement and yields before each start", async () => {
    const methods = [
      { method: "sessions.subscribe" },
      { method: "sessions.list" },
      { method: "models.list" },
      { method: "sessions.messages.subscribe", params: { includeApprovals: true } },
    ];
    const completions = Array.from({ length: 8 }, () => createDeferredCore());
    const full = createDeferredCore();
    const fifth = createDeferredCore();
    const events: string[] = [];
    const callers = completions.map((completion, index) => {
      const permission = scheduleGatewayRequestStart(
        100,
        methods[index % methods.length]!,
        `reconnect-${index}`,
        completion.promise,
      );
      if (!permission) {
        throw new Error("expected reconnect capacity");
      }
      return permission.then(() => {
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
      });
    });
    try {
      await full.promise;
      expect(events).toEqual(["start-0", "socket I/O", "start-1", "start-2", "start-3"]);
      completions[0]!.resolve();
      await fifth.promise;
      expect(events.at(-1)).toBe("start-4");
    } finally {
      for (const completion of completions) {
        completion.resolve();
      }
      await Promise.all(callers);
    }
  });

  it("releases a cancelled preparation waiter while earlier requests still own capacity", async () => {
    const settled = Array.from({ length: 4 }, () => createDeferredCore());
    const request = { method: "sessions.subscribe" };
    const held = settled.map((completion, index) => {
      const permission = scheduleGatewayRequestStart(
        100,
        request,
        `held-${index}`,
        completion.promise,
      );
      if (!permission) {
        throw new Error("expected reconnect capacity");
      }
      return permission;
    });
    const controller = new AbortController();
    const cancelled = scheduleGatewayRequestStart(
      100,
      request,
      "cancelled",
      Promise.resolve(),
      controller.signal,
    );
    try {
      await Promise.all(held);
      controller.abort();
      await expect(cancelled).resolves.toBeUndefined();
    } finally {
      for (const completion of settled) {
        completion.resolve();
      }
      await Promise.all(held);
    }
    await expect(requestStart()).resolves.toBeUndefined();
  });

  it.each(["settled", "cancelled"] as const)(
    "bounds settlement listeners while sibling requests are %s",
    async (outcome) => {
      const held = createDeferredCore();
      const observeSettlement = vi.spyOn(held.promise, "then");
      const siblings = Array.from({ length: 3 }, () => createDeferredCore());
      const request = { method: "sessions.list" };
      const start = (settled: Promise<void>, signal?: AbortSignal) => {
        const permission = scheduleGatewayRequestStart(100, request, "client", settled, signal);
        if (!permission) {
          throw new Error("expected preparation capacity");
        }
        permissions.push(permission);
        return permission;
      };
      try {
        await Promise.all([
          start(held.promise),
          ...siblings.map((sibling) => start(sibling.promise)),
        ]);
        for (let index = 0; index < 32; index++) {
          const completion = createDeferredCore();
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
      } finally {
        held.resolve();
        for (const sibling of siblings) {
          sibling.resolve();
        }
      }
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

function receiverSocket(readonly = false): WebSocket {
  return {
    _receiver: Object.defineProperty({ _allowSynchronousEvents: false }, "_maxPayload", {
      value: MAX_PREAUTH_PAYLOAD_BYTES,
      writable: !readonly,
    }),
  } as unknown as WebSocket;
}

function payloadLimit(socket: WebSocket): number {
  const receiver = (
    socket as unknown as {
      _receiver: {
        _maxPayload: number;
      };
    }
  )["_receiver"];
  return receiver["_maxPayload"];
}

describe("authenticated receiver payload limits", () => {
  it.each([false, true])(
    "respects receiver mutability during handoff and worker admission (readonly: %s)",
    (readonly) => {
      const socket = receiverSocket(readonly);
      const handoff = prepareGatewayReceiverHandoff(socket, "operator");
      expect(payloadLimit(socket)).toBe(MAX_PREAUTH_PAYLOAD_BYTES);
      if (readonly) {
        expect(handoff).toMatchObject({
          ok: false,
          error: { cause: "unsupported-websocket-receiver" },
        });
      } else {
        expect(handoff.ok).toBe(true);
        if (handoff.ok) {
          handoff.value();
        }
        expect(payloadLimit(socket)).toBe(MAX_PAYLOAD_BYTES);
      }
      expect(raiseGatewayReceiverPayloadLimit(socket, 1_024)).toBe(!readonly);
      expect(payloadLimit(socket)).toBe(readonly ? MAX_PREAUTH_PAYLOAD_BYTES : 1_024);
    },
  );
});
