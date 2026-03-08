import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("gateway.mdns schema", () => {
  it("accepts gateway.mdns.enabled: false", () => {
    const res = validateConfigObject({
      gateway: { mdns: { enabled: false } },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts gateway.mdns.enabled: true", () => {
    const res = validateConfigObject({
      gateway: { mdns: { enabled: true } },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts gateway.mdns as empty object", () => {
    const res = validateConfigObject({
      gateway: { mdns: {} },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects unknown keys inside gateway.mdns", () => {
    const res = validateConfigObject({
      gateway: { mdns: { unknown: true } },
    });
    expect(res.ok).toBe(false);
  });
});
