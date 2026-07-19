import { describe, expect, it, vi } from "vitest";
import {
  materializeAuthorizationJson,
  materializeAuthorizationToolInput,
} from "./authorization-policy-input.js";

describe("authorization policy input materialization", () => {
  it("detaches nested aliases", () => {
    const input = { action: "reply", nested: { target: "channel" } };

    const snapshot = materializeAuthorizationToolInput(input);
    input.nested.target = "mutated";

    expect(snapshot).toEqual({ action: "reply", nested: { target: "channel" } });
    expect(snapshot).not.toBe(input);
    expect(snapshot?.nested).not.toBe(input.nested);
  });

  it("rejects proxies without invoking traps", () => {
    const get = vi.fn();
    const ownKeys = vi.fn();
    const proxy = new Proxy(
      { action: "reply" },
      {
        get,
        ownKeys,
      },
    );

    expect(materializeAuthorizationToolInput(proxy)).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it("rejects accessors without evaluating them", () => {
    const read = vi.fn(() => "reply");
    const input = Object.defineProperty({}, "action", {
      enumerable: true,
      get: read,
    });

    expect(materializeAuthorizationToolInput(input)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects custom prototypes, sparse arrays, symbols, and cycles", () => {
    expect(materializeAuthorizationToolInput(Object.create({ action: "reply" }))).toBeUndefined();
    const sparse = Array.from({ length: 2 }) as unknown[];
    delete sparse[0];
    sparse[1] = "value";
    expect(materializeAuthorizationJson(sparse)).toBeUndefined();
    expect(materializeAuthorizationToolInput({ [Symbol("secret")]: true })).toBeUndefined();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(materializeAuthorizationToolInput(cyclic)).toBeUndefined();
  });
});
