import { describe, expect, it } from "vitest";
import { mergeConfigSection, mergeWhatsAppConfig } from "./merge-config.js";

describe("mergeConfigSection", () => {
  it("applies patch values to base", () => {
    const base = { a: 1, b: 2 };
    const patch = { b: 42, c: 3 };
    const result = mergeConfigSection(base, patch);
    expect(result).toEqual({ a: 1, b: 42, c: 3 });
  });

  it("returns patch values when base is undefined", () => {
    const result = mergeConfigSection(undefined, { x: "hello", y: "world" });
    expect(result).toEqual({ x: "hello", y: "world" });
  });

  it("skips undefined patch values by default", () => {
    const base = { a: 1, b: 2 };
    const result = mergeConfigSection(base, { a: undefined });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("removes keys listed in unsetOnUndefined when patch value is undefined", () => {
    const base = { a: 1, b: 2, c: 3 };
    const result = mergeConfigSection(base, { b: undefined }, { unsetOnUndefined: ["b"] });
    expect(result).toEqual({ a: 1, c: 3 });
    expect("b" in result).toBe(false);
  });

  it("does not remove keys NOT in unsetOnUndefined when patch value is undefined", () => {
    const base = { a: 1, b: 2, c: 3 };
    const result = mergeConfigSection(
      base,
      { a: undefined, b: undefined },
      { unsetOnUndefined: ["b"] },
    );
    expect(result).toEqual({ a: 1, c: 3 });
    expect("a" in result).toBe(true);
    expect("b" in result).toBe(false);
  });

  it("preserves keys not mentioned in patch", () => {
    const base = { keep: "me", also: "keep" };
    const result = mergeConfigSection(base, { extra: "new" });
    expect(result).toEqual({ keep: "me", also: "keep", extra: "new" });
  });

  it("overrides existing keys in base with patch values", () => {
    const base = { name: "old", count: 0 };
    const result = mergeConfigSection(base, { name: "new", count: 5 });
    expect(result).toEqual({ name: "new", count: 5 });
  });
});

describe("mergeWhatsAppConfig", () => {
  it("merges whatsapp config into channels", () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const cfg = { channels: { whatsapp: { sendReadReceipts: true } } } as any;
    const result = mergeWhatsAppConfig(cfg, { sendReadReceipts: false });
    expect(result.channels?.whatsapp?.sendReadReceipts).toBe(false);
  });

  it("preserves other config properties", () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const cfg = { model: "gpt-4", channels: { whatsapp: { sendReadReceipts: true } } } as any;
    const result = mergeWhatsAppConfig(cfg, { sendReadReceipts: false });
    expect(result).toHaveProperty("model", "gpt-4");
    expect(result.channels?.whatsapp?.sendReadReceipts).toBe(false);
  });

  it("preserves other channel configs", () => {
    const cfg = {
      channels: { whatsapp: { sendReadReceipts: true }, telegram: { botToken: "abc" } },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;
    const result = mergeWhatsAppConfig(cfg, { sendReadReceipts: false });
    expect(result.channels?.telegram).toEqual({ botToken: "abc" });
    expect(result.channels?.whatsapp?.sendReadReceipts).toBe(false);
  });

  it("works with undefined base whatsapp config", () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const cfg = { channels: {} } as any;
    const result = mergeWhatsAppConfig(cfg, { sendReadReceipts: true });
    expect(result.channels?.whatsapp).toEqual({ sendReadReceipts: true });
  });
});
