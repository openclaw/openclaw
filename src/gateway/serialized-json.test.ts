import { describe, expect, it, vi } from "vitest";
import {
  registerSerializedJsonArray,
  SerializedJsonArray,
  serializeGatewayFrame,
} from "./serialized-json.js";

describe("serialized Gateway response arrays", () => {
  it("forwards worker JSON without materializing its messages", () => {
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
    const encoded = serializeGatewayFrame(frame);
    expect(Buffer.isBuffer(encoded)).toBe(true);
    expect(encoded.toString()).toBe(JSON.stringify(expected));
    expect(JSON.parse(encoded.toString())).toEqual(expected);
    expect(materialize).not.toHaveBeenCalled();
  });

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
