import { describe, expect, it, vi } from "vitest";
import {
  registerSerializedJsonArray,
  serializedJsonArrayBytes,
  SerializedGatewayFrame,
  SerializedJsonArray,
  SerializedJsonPayload,
  serializeGatewayFrame,
} from "./serialized-json.js";

describe("serialized Gateway response arrays", () => {
  it.each([{ rows: [] }, { rows: [{ label: '雪🦞\\"\n' }, { label: "ready" }] }])(
    "defers owned array encoding until transport use and reuses it thereafter (%j)",
    ({ rows }) => {
      const allocate = vi.spyOn(Buffer, "allocUnsafeSlow");
      try {
        registerSerializedJsonArray(
          rows,
          rows.map((row) => JSON.stringify(row)),
        );
        const retainedBytes = serializedJsonArrayBytes(rows);
        expect(retainedBytes).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(rows)));
        expect(allocate).not.toHaveBeenCalled();
        const frame = { type: "res", payload: { rows } };
        const first = serializeGatewayFrame(frame);
        expect(allocate).toHaveBeenCalledOnce();
        const second = serializeGatewayFrame(frame);
        expect(allocate).toHaveBeenCalledOnce();
        expect(first).toBeInstanceOf(SerializedGatewayFrame);
        expect(second).toBeInstanceOf(SerializedGatewayFrame);
        const segment = (first as SerializedGatewayFrame).segments.find(
          (part) => Buffer.from(part).toString() === JSON.stringify(rows),
        );
        expect(segment).toBeDefined();
        expect((second as SerializedGatewayFrame).segments).toContain(segment);
        expect(serializedJsonArrayBytes(rows)).toBe(retainedBytes);
        expect(first.toString()).toBe(JSON.stringify(frame));
      } finally {
        allocate.mockRestore();
      }
    },
  );

  it("retains only owned bytes for cached arrays and shared response payloads", () => {
    const rows = [{ label: '雪🦞\\"\n' }];
    registerSerializedJsonArray(
      rows,
      rows.map((row) => JSON.stringify(row)),
    );
    const frame = serializeGatewayFrame({ type: "res", payload: { rows } });
    expect(frame).toBeInstanceOf(SerializedGatewayFrame);
    const bytes = (frame as SerializedGatewayFrame).segments.find(
      (part) =>
        Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString() ===
        JSON.stringify(rows),
    )!;
    expect(bytes.buffer.byteLength).toBe(bytes.byteLength);

    for (const payload of [{ rows }, { text: '雪🦞\\"\n' }, undefined, null]) {
      const shared = new SerializedJsonPayload(payload);
      expect(shared.toJSON()).toEqual(payload);
      // The cached slice may borrow its own response envelope, never a global slab.
      expect(shared.bytes.buffer.byteLength).toBeLessThanOrEqual(shared.bytes.byteLength + 14);
      expect(serializeGatewayFrame({ type: "res", id: "one", payload: shared }).toString()).toBe(
        JSON.stringify({ type: "res", id: "one", payload }),
      );
    }
  });

  it.each([false, true])(
    "forwards worker JSON without materializing its messages (subscription=%s)",
    (subscription) => {
      const messages = [{ role: "assistant", content: 'é🦞\\\"\n__RAW_JSON_0__' }, null];
      const bytes = Buffer.from(`prefix${JSON.stringify(messages)}suffix`);
      const carrier = new SerializedJsonArray(bytes.subarray(6, -6));
      const materialize = vi.spyOn(carrier, "materialize");
      const frame = {
        type: "res",
        id: "request",
        ok: true,
        payload: {
          omitted: undefined,
          messages: carrier,
          nullable: null,
          values: [undefined, null],
          marker: '"messages":__RAW_JSON_0__',
          custom: { toJSON: (key: string) => key },
        },
        error: undefined,
      };
      const expected = {
        type: "res",
        id: "request",
        ok: true,
        payload: {
          messages,
          nullable: null,
          values: [null, null],
          marker: '"messages":__RAW_JSON_0__',
          custom: "custom",
        },
      };
      const wireFrame = subscription
        ? { ...frame, payload: { initialHistory: { ok: true, payload: frame.payload } } }
        : frame;
      const wireExpected = subscription
        ? { ...expected, payload: { initialHistory: { ok: true, payload: expected.payload } } }
        : expected;
      const encoded = serializeGatewayFrame(wireFrame);
      expect(encoded).toBeInstanceOf(SerializedGatewayFrame);
      if (!(encoded instanceof SerializedGatewayFrame)) {
        throw new Error("Expected segmented worker response");
      }
      expect(encoded.segments).toContain(carrier.bytes);
      expect(encoded.toString()).toBe(JSON.stringify(wireExpected));
      expect(JSON.parse(encoded.toString())).toEqual(wireExpected);
      expect(materialize).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "reuses row bytes in ordinary list arrays (subscription=%s)",
    (subscription) => {
      const row = { key: "agent:main:one", label: 'é🦞\\\"\nready' };
      const encoded = JSON.stringify(row);
      const toJSON = vi.fn(() => row);
      const sessions = registerSerializedJsonArray(
        Object.freeze([Object.freeze({ ...row, toJSON })]),
        [encoded],
      );
      const list = { count: 1, sessions };
      const payload = subscription ? { subscribed: true, list } : list;
      const frame = { type: "res", id: "list", ok: true, payload };
      const serialized = serializeGatewayFrame(frame);
      expect(toJSON).not.toHaveBeenCalled();
      expect(JSON.parse(serialized.toString())).toEqual({
        ...frame,
        payload: subscription
          ? { subscribed: true, list: { count: 1, sessions: [row] } }
          : { count: 1, sessions: [row] },
      });
      expect(Array.isArray(sessions)).toBe(true);
      expect(JSON.stringify(frame)).toBe(serialized.toString());
      expect(toJSON).toHaveBeenCalledOnce();
    },
  );

  it("preserves ordinary responses and JSON callers", () => {
    const messages = [{ text: "ready" }];
    const carrier = new SerializedJsonArray(Buffer.from(JSON.stringify(messages)));
    const frame = { type: "res", id: "ordinary", ok: true, payload: { messages } };
    expect(serializeGatewayFrame(frame)).toBe(JSON.stringify(frame));
    expect(JSON.stringify({ messages: carrier })).toBe(JSON.stringify({ messages }));
    expect(carrier.materialize()).toEqual(messages);
    expect(() => new SerializedJsonArray(Buffer.from("{}")).materialize()).toThrow(
      "must contain an array",
    );
  });
});
