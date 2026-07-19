import { describe, expect, it, vi } from "vitest";
import {
  digestOutboundEffectPayload,
  materializeOutboundEffectPayload,
} from "./effect-authorization.js";

describe("outbound effect authorization digest", () => {
  it("keeps tri-state and arbitrary false fields distinct from absence", () => {
    expect(digestOutboundEffectPayload({ text: "hello", replyToCurrent: false })).not.toBe(
      digestOutboundEffectPayload({ text: "hello" }),
    );
    expect(digestOutboundEffectPayload({ text: "hello", isError: false })).not.toBe(
      digestOutboundEffectPayload({ text: "hello" }),
    );
  });

  it("normalizes only proven false defaults", () => {
    const absent = digestOutboundEffectPayload({ text: "hello" });
    expect(digestOutboundEffectPayload({ text: "hello", replyToTag: false })).toBe(absent);
    expect(digestOutboundEffectPayload({ text: "hello", audioAsVoice: false })).toBe(absent);
  });

  it("rejects accessors and custom serialization without invoking them", () => {
    const getter = vi.fn(() => "hidden");
    const toJSON = vi.fn(() => ({ text: "forged" }));
    const channelData = Object.defineProperty({}, "secret", {
      get: getter,
      enumerable: true,
    });
    const serialized = { toJSON };

    expect(() =>
      digestOutboundEffectPayload({ channelData: channelData as Record<string, unknown> }),
    ).toThrow("enumerable data fields");
    expect(() =>
      digestOutboundEffectPayload({ channelData: serialized as Record<string, unknown> }),
    ).toThrow("plain data");
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("rejects custom prototypes and proxies before their traps run", () => {
    const custom = Object.create({ inherited: "value" }) as Record<string, unknown>;
    custom.value = "data";
    const getPrototypeOf = vi.fn(() => Object.prototype);
    const ownKeys = vi.fn(() => ["value"]);
    const proxied = new Proxy(
      { value: "data" },
      {
        getPrototypeOf,
        ownKeys,
      },
    );

    expect(() => digestOutboundEffectPayload({ channelData: custom })).toThrow("plain prototype");
    expect(() => digestOutboundEffectPayload({ channelData: proxied })).toThrow("proxies");
    expect(getPrototypeOf).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();
  });

  it("materializes a detached payload snapshot", () => {
    const source = { text: "hello", channelData: { nested: { value: "before" } } };
    const snapshot = materializeOutboundEffectPayload(source);
    (source.channelData.nested as { value: string }).value = "after";

    expect(snapshot).toEqual({
      text: "hello",
      channelData: { nested: { value: "before" } },
    });
    expect(digestOutboundEffectPayload(snapshot)).not.toBe(digestOutboundEffectPayload(source));
  });
});
