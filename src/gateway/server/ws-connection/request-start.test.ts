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

  it("bounds one connection without consuming another connection's start capacity", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const accepted = Array.from({ length: 257 }, () => requestStart());
    expect(scheduleGatewayRequestStart(1, workRequest, "connection", Promise.resolve())).toBeNull();
    const other = requestStart(1, workRequest, "another-connection");
    await Promise.all([...accepted, other]);
    await expect(requestStart()).resolves.toBeUndefined();
  });

  it("admits a hundred clients' grouped setup requests in FIFO order", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const methods = [
      "exec.approval.list",
      "plugin.approval.list",
      "openclaw.approval.list",
      "cron.status",
      "cron.list",
    ];
    const starts: number[] = [];
    const setup = Array.from({ length: 100 }, (_, client) =>
      methods.map((method, offset) =>
        requestStart(200, { method }, `client-${client}`).then(() => {
          starts.push(client * methods.length + offset);
        }),
      ),
    ).flat();
    await Promise.all(setup);
    expect(starts).toEqual(Array.from({ length: 500 }, (_, index) => index));
  });

  it("accounts the original serialized bytes independently of frame count", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const first = requestStart(25 * 1024 * 1024);
    const second = requestStart(25 * 1024 * 1024);
    const third = requestStart(25 * 1024 * 1024);
    expect(scheduleGatewayRequestStart(1, workRequest, "connection", Promise.resolve())).toBeNull();
    await Promise.all([first, second, third]);
    await expect(requestStart(25 * 1024 * 1024)).resolves.toBeUndefined();
  });

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
    { bytes: 1, count: 1024 },
    { bytes: 4096, count: 256 },
  ])(
    "bounds subscription waiting capacity at $count frames of $bytes bytes",
    async ({ bytes, count }) => {
      vi.spyOn(performance, "now").mockReturnValue(0);
      const active = requestStart();
      const controls = Array.from({ length: count }, (_, index) =>
        requestStart(bytes, subscribeRequest, `client-${index}`),
      );
      expect(
        scheduleGatewayRequestStart(bytes, subscribeRequest, "overflow", Promise.resolve()),
      ).toBeNull();
      const work = requestStart();
      await Promise.all([active, work, ...controls]);
      await expect(requestStart(bytes, subscribeRequest, "overflow")).resolves.toBeUndefined();
    },
  );

  it("bounds one connection's pending controls without consuming another connection's reserve", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const active = requestStart();
    const unsubscribe = { method: "sessions.messages.unsubscribe", params: { key: "session" } };
    const controls = Array.from({ length: 16 }, () => requestStart(180, unsubscribe));
    expect(
      scheduleGatewayRequestStart(180, subscribeRequest, "connection", Promise.resolve()),
    ).toBeNull();
    const other = requestStart(180, subscribeRequest, "another-connection");
    await Promise.all([active, other, ...controls]);
    await expect(requestStart(180, subscribeRequest)).resolves.toBeUndefined();
  });
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
  it("raises the receiver limit only after connect", () => {
    const socket = receiverSocket();
    const handoff = prepareGatewayReceiverHandoff(socket, "operator");
    expect(handoff.ok).toBe(true);
    expect(payloadLimit(socket)).toBe(MAX_PREAUTH_PAYLOAD_BYTES);
    if (handoff.ok) {
      handoff.value();
    }
    expect(payloadLimit(socket)).toBe(MAX_PAYLOAD_BYTES);
  });

  it("raises an admitted worker receiver limit", () => {
    const socket = receiverSocket();
    expect(raiseGatewayReceiverPayloadLimit(socket, 1_024)).toBe(true);
    expect(payloadLimit(socket)).toBe(1_024);
  });

  it("refuses the handoff when the receiver limit cannot be raised", () => {
    const socket = receiverSocket(true);
    expect(prepareGatewayReceiverHandoff(socket, "operator")).toMatchObject({
      ok: false,
      error: { cause: "unsupported-websocket-receiver" },
    });
    expect(raiseGatewayReceiverPayloadLimit(socket, 1_024)).toBe(false);
    expect(payloadLimit(socket)).toBe(MAX_PREAUTH_PAYLOAD_BYTES);
  });
});
