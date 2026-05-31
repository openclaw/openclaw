import { describe, expect, it } from "vitest";
import {
  editDistance,
  getKnownKeysAtSchemaPath,
  suggestClosestKey,
} from "./did-you-mean.js";

describe("editDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(editDistance("foo", "foo")).toBe(0);
  });
  it("counts insertions, deletions, and substitutions", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("port", "Port")).toBe(1);
  });
});

describe("suggestClosestKey", () => {
  const keys = ["model", "modelRef", "primary", "fallbacks", "tools"];

  it("suggests a close match within the threshold", () => {
    expect(suggestClosestKey("modle", keys)).toBe("model");
    expect(suggestClosestKey("primery", keys)).toBe("primary");
  });

  it("returns null when the unknown key is far from any candidate", () => {
    expect(suggestClosestKey("nope", keys)).toBeNull();
    expect(suggestClosestKey("xyzzy", keys, { maxDistance: 2 })).toBeNull();
  });

  it("ignores exact matches so the suggestion never names the unknown key itself", () => {
    // With threshold 2 the only candidate within reach of "model" is itself,
    // which we skip, so no suggestion fires.
    expect(suggestClosestKey("model", keys)).toBeNull();
    // Loosening the threshold lets nearby candidates surface again.
    expect(suggestClosestKey("model", keys, { maxDistance: 4 })).toBe("modelRef");
    expect(suggestClosestKey("model", keys, { maxDistance: 4 })).not.toBe("model");
  });

  it("is case insensitive but returns the canonical cased candidate", () => {
    expect(suggestClosestKey("MODEL", ["model"])).toBe("model");
    expect(suggestClosestKey("Port", ["port"])).toBe("port");
  });

  it("returns null for empty inputs", () => {
    expect(suggestClosestKey("", keys)).toBeNull();
    expect(suggestClosestKey("foo", [])).toBeNull();
  });

  it("ties break on lexicographic order so the suggestion is stable", () => {
    expect(suggestClosestKey("aa", ["ab", "ba"])).toBe("ab");
  });
});

describe("getKnownKeysAtSchemaPath", () => {
  const root = {
    type: "object",
    properties: {
      gateway: {
        type: "object",
        properties: {
          port: { type: "number" },
          mode: { type: "string" },
          reload: {
            type: "object",
            properties: {
              mode: { type: "string" },
              debounceMs: { type: "number" },
            },
          },
        },
      },
      channels: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            botToken: { type: "string" },
          },
        },
      },
    },
  };

  it("returns the root keys for an empty path", () => {
    expect([...getKnownKeysAtSchemaPath(root, [])]).toEqual(["gateway", "channels"]);
  });

  it("descends through nested object paths", () => {
    expect([...getKnownKeysAtSchemaPath(root, ["gateway"])]).toEqual(["port", "mode", "reload"]);
    expect([...getKnownKeysAtSchemaPath(root, ["gateway", "reload"])]).toEqual([
      "mode",
      "debounceMs",
    ]);
  });

  it("falls through additionalProperties when a key is not in properties", () => {
    expect([...getKnownKeysAtSchemaPath(root, ["channels", "telegram"])]).toEqual([
      "enabled",
      "botToken",
    ]);
  });

  it("returns an empty list when the path does not resolve", () => {
    expect([...getKnownKeysAtSchemaPath(root, ["nonexistent"])]).toEqual([]);
    expect([...getKnownKeysAtSchemaPath(root, ["gateway", "port"])]).toEqual([]);
  });
});
