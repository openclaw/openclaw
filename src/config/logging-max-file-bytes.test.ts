import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("logging.maxFileBytes config", () => {
  it("accepts a positive maxFileBytes", () => {
    const res = validateConfigObject({
      logging: {
        maxFileBytes: 1024,
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects non-positive maxFileBytes", () => {
    const res = validateConfigObject({
      logging: {
        maxFileBytes: 0,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((issue) => issue.path === "logging.maxFileBytes")).toBe(true);
    }
  });
});

describe("diagnostics JSONL rotation config", () => {
  it("accepts bounded rotation settings, including zero to disable a bound", () => {
    const res = validateConfigObject({
      diagnostics: {
        cacheTrace: {
          maxFileBytes: 0,
          maxArchives: 0,
        },
        anthropicPayloadLog: {
          enabled: true,
          maxFileBytes: 1024,
          maxArchives: 2,
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects negative diagnostics JSONL rotation settings", () => {
    const res = validateConfigObject({
      diagnostics: {
        cacheTrace: {
          maxFileBytes: -1,
        },
        anthropicPayloadLog: {
          maxArchives: -1,
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((issue) => issue.path === "diagnostics.cacheTrace.maxFileBytes")).toBe(
        true,
      );
      expect(
        res.issues.some((issue) => issue.path === "diagnostics.anthropicPayloadLog.maxArchives"),
      ).toBe(true);
    }
  });

  it("rejects excessive diagnostics JSONL archive retention settings", () => {
    const res = validateConfigObject({
      diagnostics: {
        cacheTrace: {
          maxArchives: 11,
        },
        anthropicPayloadLog: {
          maxArchives: 11,
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((issue) => issue.path === "diagnostics.cacheTrace.maxArchives")).toBe(
        true,
      );
      expect(
        res.issues.some((issue) => issue.path === "diagnostics.anthropicPayloadLog.maxArchives"),
      ).toBe(true);
    }
  });
});
