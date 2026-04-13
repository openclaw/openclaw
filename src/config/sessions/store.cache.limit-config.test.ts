import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_OBJECT_CACHE_MAX_BYTES,
  resolveSessionObjectCacheMaxBytes,
} from "./store-cache-limit.js";

describe("session object cache limit config", () => {
  it("defaults to 1 MB when the env var is unset", () => {
    expect(resolveSessionObjectCacheMaxBytes(undefined)).toBe(
      DEFAULT_SESSION_OBJECT_CACHE_MAX_BYTES,
    );
  });

  it("accepts a positive integer override", () => {
    expect(resolveSessionObjectCacheMaxBytes("2048")).toBe(2048);
  });

  it("accepts zero to disable the object cache", () => {
    expect(resolveSessionObjectCacheMaxBytes("0")).toBe(0);
  });

  it("falls back to the default for invalid values", () => {
    expect(resolveSessionObjectCacheMaxBytes("-1")).toBe(DEFAULT_SESSION_OBJECT_CACHE_MAX_BYTES);
    expect(resolveSessionObjectCacheMaxBytes("not-a-number")).toBe(
      DEFAULT_SESSION_OBJECT_CACHE_MAX_BYTES,
    );
  });
});
