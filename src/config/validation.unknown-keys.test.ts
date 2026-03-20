import { describe, expect, it } from "vitest";
import { validateConfigObject, validateConfigObjectRaw } from "./config.js";

describe("unknown config key recovery", () => {
  it("strips a single unknown top-level key and succeeds with warnings", () => {
    const res = validateConfigObjectRaw({
      gateway: { port: 18789 },
      bogusTopLevelKey: true,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.gateway?.port).toBe(18789);
      expect((res.config as Record<string, unknown>).bogusTopLevelKey).toBeUndefined();
      expect(res.warnings).toBeDefined();
      expect(res.warnings!.length).toBe(1);
      expect(res.warnings![0].path).toBe("bogusTopLevelKey");
      expect(res.warnings![0].message).toContain("Unrecognized config key");
    }
  });

  it("strips unknown keys nested inside a known section", () => {
    const res = validateConfigObjectRaw({
      gateway: {
        port: 18789,
        madeUpField: "hello",
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.gateway?.port).toBe(18789);
      expect(res.warnings).toBeDefined();
      expect(res.warnings!.length).toBe(1);
      expect(res.warnings![0].path).toBe("gateway.madeUpField");
    }
  });

  it("strips multiple unknown keys across different sections", () => {
    const res = validateConfigObjectRaw({
      gateway: {
        port: 18789,
        unknownA: 1,
      },
      unknownB: "two",
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.gateway?.port).toBe(18789);
      expect(res.warnings).toBeDefined();
      expect(res.warnings!.length).toBe(2);
      const paths = res.warnings!.map((w) => w.path).toSorted();
      expect(paths).toEqual(["gateway.unknownA", "unknownB"]);
    }
  });

  it("still fails closed when errors include non-unrecognized-key issues", () => {
    const res = validateConfigObjectRaw({
      gateway: {
        port: "not-a-number", // type error
        madeUpField: "hello", // unrecognized key
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      // Should contain both kinds of issues (Zod reports them all)
      expect(res.issues.length).toBeGreaterThan(0);
    }
  });

  it("still fails closed for purely structural errors", () => {
    const res = validateConfigObjectRaw({
      gateway: {
        port: "not-a-number",
      },
    });

    expect(res.ok).toBe(false);
  });

  it("returns no warnings when config is already valid", () => {
    const res = validateConfigObjectRaw({
      gateway: { port: 18789 },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.warnings).toBeUndefined();
    }
  });

  it("propagates warnings through validateConfigObject", () => {
    const res = validateConfigObject({
      gateway: { port: 18789 },
      bogusKey: true,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.gateway?.port).toBe(18789);
      expect(res.warnings).toBeDefined();
      expect(res.warnings!.length).toBe(1);
      expect(res.warnings![0].path).toBe("bogusKey");
    }
  });

  it("does not write stripped config back to disk (in-memory only)", () => {
    // This test validates the contract: the original raw object is not mutated.
    const raw = {
      gateway: { port: 18789, spuriousKey: "value" },
    };
    const rawCopy = structuredClone(raw);

    const res = validateConfigObjectRaw(raw);

    expect(res.ok).toBe(true);
    // The original object must not have been modified
    expect(raw).toEqual(rawCopy);
  });

  it("fails gracefully when unknown-key recovery cannot clone the raw input", () => {
    const res = validateConfigObjectRaw({
      gateway: {
        port: 18789,
        bogusHandler: () => "not-cloneable",
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.message).toContain("Unrecognized key");
    }
  });

  it("handles deeply nested unknown keys in channel config", () => {
    const res = validateConfigObjectRaw({
      channels: {
        telegram: {
          inlineButtons: "dm", // not in schema — the scenario from the issue
        },
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.warnings).toBeDefined();
      expect(res.warnings!.length).toBe(1);
      expect(res.warnings![0].path).toBe("channels.telegram.inlineButtons");
    }
  });
});
