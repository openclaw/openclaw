import { describe, expect, it, vi } from "vitest";
import { createDeferred, nextEventLoopTurn } from "../../test/helpers/promise.js";
import { createNodeDuplexEndpoint } from "./node-duplex-framing.js";

const FRAGMENT_BYTES = 8 * 1024;
const MAX_MESSAGE_BYTES = 100 * 1024 * 1024;

function createEndpoint(options: Partial<Parameters<typeof createNodeDuplexEndpoint>[0]> = {}) {
  return createNodeDuplexEndpoint({ sendFrame: () => {}, ...options });
}

function senderFor(
  receiver: ReturnType<typeof createEndpoint>,
  options: Partial<Parameters<typeof createNodeDuplexEndpoint>[0]> = {},
) {
  return createEndpoint({
    sendFrame: (frame) => receiver.receive(JSON.stringify(frame)),
    ...options,
  });
}

function listeningEndpoint(
  listener: Parameters<ReturnType<typeof createEndpoint>["onMessage"]>[0],
  options: Partial<Parameters<typeof createNodeDuplexEndpoint>[0]> = {},
) {
  const endpoint = createEndpoint(options);
  endpoint.onMessage(listener);
  return endpoint;
}

function asyncSenderFor(receiver: ReturnType<typeof createEndpoint>) {
  return createEndpoint({
    async sendFrame(frame) {
      await Promise.resolve();
      receiver.receive(JSON.stringify(frame));
    },
  });
}

function recordingEndpoint(
  sendFrame: (frame: string) => void,
  options: Partial<Parameters<typeof createEndpoint>[0]> = {},
) {
  const frames: string[] = [];
  const messages: Uint8Array[] = [];
  const endpoint = listeningEndpoint(
    (message) => {
      messages.push(message);
    },
    {
      ...options,
      async sendFrame(frame) {
        await Promise.resolve();
        const serialized = JSON.stringify(frame);
        frames.push(serialized);
        sendFrame(serialized);
      },
    },
  );
  return { endpoint, frames, messages };
}

const fullFragment = Buffer.alloc(FRAGMENT_BYTES).toString("base64");
const readyFrame = JSON.stringify({ v: 1, kind: "ready" });

function dataFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    kind: "data",
    message: 0,
    index: 0,
    last: true,
    data: Buffer.from("message").toString("base64"),
    ...overrides,
  });
}

describe("node duplex message framing", () => {
  it("orders readiness, exact binary views, empty messages and heartbeats in both directions", async () => {
    const events: string[] = [];
    const left = recordingEndpoint((frame) => right.endpoint.receive(frame));
    const right = recordingEndpoint((frame) => left.endpoint.receive(frame), {
      onReady: () => {
        events.push("ready");
      },
      requireReady: true,
    });

    const outboundBacking = new Uint8Array(new SharedArrayBuffer(40_032)).fill(0xa5);
    const outbound = outboundBacking.subarray(17, 40_017);
    outbound.set(Uint8Array.from({ length: 40_000 }, (_, index) => index % 251));
    const inboundBacking = new Uint8Array(new ArrayBuffer(25_032)).fill(0x5a);
    const inbound = Buffer.from(inboundBacking.buffer, 11, 25_000);
    inbound.set(Uint8Array.from({ length: 25_000 }, (_, index) => 255 - (index % 251)));
    await Promise.all([left.endpoint.sendReady(), left.endpoint.send(outbound)]);
    expect(events).toEqual(["ready"]);
    await right.endpoint.send(inbound);
    right.endpoint.receive("");
    await left.endpoint.send(new Uint8Array());
    right.endpoint.receive("");
    await left.endpoint.send(Uint8Array.of(7));

    expect(right.messages).toEqual([outbound, new Uint8Array(), Uint8Array.of(7)]);
    expect(left.messages).toEqual([new Uint8Array(inbound)]);
    expect(left.frames.length).toBeGreaterThan(2);
    expect(right.frames.length).toBeGreaterThan(2);
    expect([...left.frames, ...right.frames]).toSatisfy((frames: string[]) =>
      frames.every((frame) => Buffer.byteLength(frame, "utf8") < 16 * 1024),
    );
  });

  it("preserves multi-fragment message boundaries across concurrent asynchronous sends", async () => {
    const received: Uint8Array[] = [];
    const first = Uint8Array.from({ length: 20_000 }, () => 1);
    const second = Uint8Array.from({ length: 18_000 }, () => 2);
    const receiver = createEndpoint();
    receiver.onMessage((message) => {
      received.push(message);
    });
    const sender = asyncSenderFor(receiver);

    await Promise.all([sender.send(first), sender.send(second)]);

    expect(received).toEqual([first, second]);
  });

  it("snapshots each fragment before its transport serializes it", async () => {
    const entered = createDeferred();
    const released = createDeferred();
    const received = vi.fn();
    const receiver = listeningEndpoint(received);
    const sender = createNodeDuplexEndpoint({
      async sendFrame(frame) {
        entered.resolve();
        await released.promise;
        receiver.receive(JSON.stringify(frame));
      },
    });
    const input = Uint8Array.of(1, 2, 3);
    const pending = sender.send(input);
    await entered.promise;
    input.fill(9);
    released.resolve();
    await pending;

    expect(received).toHaveBeenCalledExactlyOnceWith(Uint8Array.of(1, 2, 3));
  });

  it("rejects data before required readiness while node-host input needs no reciprocal ready", () => {
    const gatewayError = vi.fn();
    const gateway = createEndpoint({
      onError: gatewayError,
      requireReady: true,
    });

    expect(() => gateway.receive(dataFrame())).toThrow(/before framed readiness/i);
    expect(gatewayError).toHaveBeenCalledOnce();

    const hostMessage = vi.fn();
    const host = createEndpoint();
    host.onMessage(hostMessage);
    host.receive(dataFrame());
    expect(hostMessage).toHaveBeenCalledOnce();
  });

  it.each([
    ["malformed JSON", "{"],
    ["wrong version", dataFrame({ v: 2 })],
    ["unknown kind", dataFrame({ kind: "unknown" })],
    ["extra field", dataFrame({ extra: true })],
    ["noncanonical base64", dataFrame({ data: "bWVzc2FnZQ" })],
    ["invalid base64", dataFrame({ data: "%%%%" })],
    ["negative message id", dataFrame({ message: -1 })],
    ["unsafe message id", dataFrame({ message: Number.MAX_SAFE_INTEGER + 1 })],
    ["message gap", dataFrame({ message: 1 })],
    ["fragment gap", dataFrame({ index: 1 })],
    ["negative fragment index", dataFrame({ index: -1 })],
    ["unsafe fragment index", dataFrame({ index: Number.MAX_SAFE_INTEGER + 1 })],
    ["undersized nonterminal fragment", dataFrame({ last: false })],
    ["mixed ready fields", JSON.stringify({ v: 1, kind: "ready", data: "" })],
    [
      "oversized fragment",
      dataFrame({ data: Buffer.alloc(FRAGMENT_BYTES + 1).toString("base64") }),
    ],
    ["oversized wire frame", `{"data":"${"a".repeat(16 * 1024)}"}`],
  ])("fails closed on %s", (_reason, frame) => {
    const onError = vi.fn();
    const received = vi.fn();
    const endpoint = createEndpoint({ onError });
    endpoint.onMessage(received);

    expect(() => endpoint.receive(frame)).toThrow();
    expect(onError).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
    expect(() => endpoint.receive(dataFrame())).toThrow(/closed/i);
    expect(onError).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "duplicate fragment",
      [dataFrame({ last: false, data: fullFragment }), dataFrame({ index: 0 })],
    ],
    ["fragment gap", [dataFrame({ last: false, data: fullFragment }), dataFrame({ index: 2 })]],
    [
      "interleaved message",
      [dataFrame({ last: false, data: fullFragment }), dataFrame({ message: 1, index: 1 })],
    ],
    ["duplicate completed message", [dataFrame(), dataFrame()]],
    ["duplicate readiness", [readyFrame, readyFrame]],
    ["late readiness", [dataFrame(), readyFrame]],
  ])("rejects %s without delivering subsequent messages", (_reason, frames) => {
    const onError = vi.fn();
    const endpoint = listeningEndpoint(() => {}, { onError });
    endpoint.receive(frames[0]!);

    expect(() => endpoint.receive(frames[1]!)).toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("bounds pending message count and bytes before a listener subscribes", async () => {
    const countError = vi.fn();
    const countBounded = createEndpoint({ onError: countError });
    for (let message = 0; message < 8; message += 1) {
      countBounded.receive(dataFrame({ message }));
    }
    expect(() => countBounded.receive(dataFrame({ message: 8 }))).toThrow(/pending/i);
    expect(countError).toHaveBeenCalledOnce();

    const bytesError = vi.fn();
    const bytesBounded = createEndpoint({ onError: bytesError });
    const sender = senderFor(bytesBounded);
    await sender.send(new Uint8Array(600_000));
    await expect(sender.send(new Uint8Array(600_000))).rejects.toThrow(/pending/i);
    expect(bytesError).toHaveBeenCalledOnce();
  });

  it("bounds incomplete fragments against bytes already buffered before listener registration", () => {
    const onError = vi.fn();
    const endpoint = createEndpoint({ onError });
    endpoint.receive(dataFrame({ data: "eA==" }));
    for (let index = 0; index < 127; index += 1) {
      endpoint.receive(dataFrame({ message: 1, index, last: false, data: fullFragment }));
    }

    expect(() =>
      endpoint.receive(dataFrame({ message: 1, index: 127, last: false, data: fullFragment })),
    ).toThrow(/pending/i);
    expect(onError).toHaveBeenCalledOnce();
    expect(() => endpoint.receive(dataFrame({ message: 1, index: 128 }))).toThrow(/closed/i);
  });

  it("rejects oversized outbound and inbound logical messages", async () => {
    const sendFrame = vi.fn();
    const outboundError = vi.fn();
    const sender = createNodeDuplexEndpoint({
      sendFrame,
      onError: outboundError,
      maxMessageBytes: 5,
    });

    await expect(sender.send(Uint8Array.of(1, 2, 3, 4, 5, 6))).rejects.toThrow(/maximum/i);
    expect(sendFrame).not.toHaveBeenCalled();
    expect(outboundError).toHaveBeenCalledOnce();

    const inboundError = vi.fn();
    const receiver = createEndpoint({
      onError: inboundError,
      maxMessageBytes: 5,
    });
    expect(() => receiver.receive(dataFrame())).toThrow(/maximum/i);
    expect(inboundError).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, Number.NaN, MAX_MESSAGE_BYTES + 1])(
    "rejects an unsafe logical message limit of %s bytes",
    (maxMessageBytes) => {
      expect(() => createEndpoint({ maxMessageBytes })).toThrow(/maximum/i);
    },
  );

  it.each([0, 15, 16.5, Number.NaN, MAX_MESSAGE_BYTES + 1])(
    "rejects an unsafe outstanding delivery limit of %s bytes",
    (maxOutstandingDeliveryBytes) => {
      expect(() =>
        createEndpoint({
          maxMessageBytes: 16,
          maxOutstandingDeliveryBytes,
        }),
      ).toThrow(/outstanding delivery/i);
    },
  );

  it("rejects accumulated message overflow and excessive fragment counts", () => {
    const overflow = createEndpoint({
      maxMessageBytes: FRAGMENT_BYTES + 1,
    });
    overflow.receive(dataFrame({ last: false, data: fullFragment }));
    expect(() =>
      overflow.receive(dataFrame({ index: 1, data: Buffer.from("xx").toString("base64") })),
    ).toThrow(/maximum/i);

    const excessive = createEndpoint({
      maxMessageBytes: FRAGMENT_BYTES,
    });
    excessive.receive(dataFrame({ last: false, data: fullFragment }));
    expect(() => excessive.receive(dataFrame({ index: 1, data: "" }))).toThrow(/fragment/i);
  });

  it("closes when a message listener throws and never invokes it afterward", () => {
    const failure = new Error("listener exploded");
    const onError = vi.fn();
    const listener = vi.fn(() => {
      throw failure;
    });
    const endpoint = listeningEndpoint(listener, { onError });

    expect(() => endpoint.receive(dataFrame())).toThrow(failure);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(() => endpoint.receive(dataFrame({ message: 1 }))).toThrow(/closed/i);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("closes after an asynchronous buffered message listener rejects", async () => {
    const failure = new Error("asynchronous listener exploded");
    const onError = vi.fn();
    const listener = vi.fn(() => {
      const rejection = Promise.reject(failure);
      void rejection.catch(() => {});
      return rejection;
    });
    const endpoint = createEndpoint({ onError });
    endpoint.receive(dataFrame());
    endpoint.onMessage(listener);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(failure));
    expect(() => endpoint.receive(dataFrame({ message: 1 }))).toThrow(/closed/i);
    expect(listener).toHaveBeenCalledOnce();
  });

  it.each([
    ["count", Array<number>(8).fill(7), 7, {}, /pending|in.flight/i],
    ["bytes", [10], 7, { maxMessageBytes: 16 }, /pending|in.flight/i],
    [
      "expanded budget",
      [16, 8],
      1,
      { maxMessageBytes: 16, maxOutstandingDeliveryBytes: 24 },
      /pending/i,
    ],
  ] as const)(
    "bounds outstanding asynchronous listener delivery %s",
    (_limit, sizes, next, options, error) => {
      const onError = vi.fn();
      const listener = vi.fn(() => new Promise<void>(() => {}));
      const endpoint = listeningEndpoint(listener, { onError, ...options });
      sizes.forEach((size, message) => {
        endpoint.receive(dataFrame({ message, data: Buffer.alloc(size).toString("base64") }));
      });
      expect(() =>
        endpoint.receive(
          dataFrame({ message: sizes.length, data: Buffer.alloc(next).toString("base64") }),
        ),
      ).toThrow(error);
      expect(listener).toHaveBeenCalledTimes(sizes.length);
      expect(onError).toHaveBeenCalledOnce();
    },
  );

  it("delivers an exact-limit response and bounded following notification before either delivery settles", async () => {
    const maxMessageBytes = 64 * 1024 * 1024;
    const maxOutstandingDeliveryBytes = maxMessageBytes + 2 * 1024 * 1024;
    const received: Uint8Array[] = [];
    const { promise: deliveriesFinished, resolve: finishDeliveries } = createDeferred();
    const limits = { maxMessageBytes, maxOutstandingDeliveryBytes };
    const receiver = listeningEndpoint((message) => {
      received.push(message);
      return deliveriesFinished;
    }, limits);
    const sender = senderFor(receiver, limits);
    const response = Buffer.alloc(maxMessageBytes, 0x78);
    // Framing treats payloads as opaque bytes; only their aggregate size matters here.
    const notification = Buffer.alloc(1024 * 1024);

    try {
      await sender.send(response);
      await sender.send(notification);
      expect(received.map((message) => message.byteLength)).toEqual([
        maxMessageBytes,
        notification.byteLength,
      ]);
      await expect(sender.send(new Uint8Array(maxMessageBytes + 1))).rejects.toThrow(/maximum/i);
    } finally {
      finishDeliveries?.();
    }

    await receiver.drain();
  });

  it.each(["immediate", "buffered"] as const)(
    "drains an asynchronous %s listener before allowing invocation completion",
    async (delivery) => {
      const { promise: listenerFinished, resolve: finishListener } = createDeferred();
      const received: Uint8Array[] = [];
      const endpoint = createEndpoint();
      if (delivery === "buffered") {
        endpoint.receive(dataFrame());
      }
      endpoint.onMessage((message) => {
        received.push(message);
        return listenerFinished;
      });
      if (delivery === "immediate") {
        endpoint.receive(dataFrame());
      }
      endpoint.receive(dataFrame({ message: 1, data: Buffer.from("second").toString("base64") }));
      let drained = false;
      const drain = endpoint.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);

      finishListener?.();
      await drain;

      expect(drained).toBe(true);
      expect(received).toEqual([
        new Uint8Array(Buffer.from("message")),
        new Uint8Array(Buffer.from("second")),
      ]);
      received[0]!.fill(0);
      expect(received[1]).toEqual(new Uint8Array(Buffer.from("second")));
    },
  );

  it("continues draining listener work that arrives while an earlier delivery is pending", async () => {
    const finishListeners: Array<() => void> = [];
    const endpoint = createEndpoint();
    endpoint.onMessage(
      () =>
        new Promise<void>((resolve) => {
          finishListeners.push(resolve);
        }),
    );
    endpoint.receive(dataFrame());
    let drained = false;
    const drain = endpoint.drain().then(() => {
      drained = true;
    });
    endpoint.receive(dataFrame({ message: 1 }));

    finishListeners[0]?.();
    await nextEventLoopTurn();
    expect(drained).toBe(false);

    finishListeners[1]?.();
    await drain;
    expect(drained).toBe(true);
  });

  it("preserves the original asynchronous listener failure while draining", async () => {
    const { promise: listenerFinished, reject: rejectListener } = createDeferred();
    const failure = new Error("asynchronous drain listener exploded");
    const onError = vi.fn();
    const listener = vi.fn(() => listenerFinished);
    const endpoint = listeningEndpoint(listener, { onError });
    endpoint.receive(dataFrame());
    const drain = endpoint.drain();

    rejectListener?.(failure);

    await expect(drain).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(() => endpoint.receive(dataFrame({ message: 1 }))).toThrow(/closed/i);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("rejects drain immediately when closing with a listener that never settles", async () => {
    const listenerFinished = new Promise<void>(() => {});
    const endpoint = listeningEndpoint(() => listenerFinished);
    endpoint.receive(dataFrame());
    const drain = endpoint.drain();

    endpoint.close();

    await expect(drain).rejects.toThrow(/closed/i);
  });

  it("closes and reports asynchronous frame transport failure exactly once", async () => {
    const failure = new Error("node transport disconnected");
    const onError = vi.fn();
    const endpoint = createNodeDuplexEndpoint({
      async sendFrame() {
        throw failure;
      },
      onError,
    });

    await expect(endpoint.send(Uint8Array.of(1))).rejects.toThrow(failure);
    await expect(endpoint.send(Uint8Array.of(2))).rejects.toThrow(/closed/i);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it.each(["message", "ready"] as const)(
    "rejects %s when the endpoint closes during its final transport await",
    async (operation) => {
      const { promise: transportReleased, resolve: releaseTransport } = createDeferred();
      const endpoint = createNodeDuplexEndpoint({
        async sendFrame() {
          await transportReleased;
        },
      });
      const pending =
        operation === "message" ? endpoint.send(Uint8Array.of(1)) : endpoint.sendReady();
      await Promise.resolve();

      endpoint.close();
      releaseTransport?.();

      await expect(pending).rejects.toThrow(/closed/i);
    },
  );

  it("closes when the framed-ready callback rejects unexpected readiness", () => {
    const failure = new Error("node readiness preceded dispatch");
    const onError = vi.fn();
    const endpoint = createEndpoint({
      onReady() {
        throw failure;
      },
      onError,
    });

    expect(() => endpoint.receive(readyFrame)).toThrow(failure);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("rejects a second active listener and subscriptions after closure", () => {
    const endpoint = createEndpoint();
    const unsubscribe = endpoint.onMessage(() => {});

    expect(() => endpoint.onMessage(() => {})).toThrow(/listener/i);
    unsubscribe();
    endpoint.onMessage(() => {});
    endpoint.close();
    expect(() => endpoint.onMessage(() => {})).toThrow(/closed/i);
  });

  it("rejects retained send and incoming data after an idempotent close", async () => {
    const listener = vi.fn();
    const endpoint = listeningEndpoint(listener);

    endpoint.close();
    endpoint.close();

    await expect(endpoint.send(Uint8Array.of(1))).rejects.toThrow(/closed/i);
    expect(() => endpoint.receive(dataFrame())).toThrow(/closed/i);
    expect(listener).not.toHaveBeenCalled();
  });
});
