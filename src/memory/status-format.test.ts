import { describe, expect, it } from "vitest";
import {
  resolveMemoryVectorState,
  resolveMemoryFtsState,
  resolveMemoryCacheSummary,
  resolveMemoryCacheState,
} from "./status-format.js";

describe("resolveMemoryVectorState", () => {
  it("returns disabled when not enabled", () => {
    expect(resolveMemoryVectorState({ enabled: false })).toEqual({
      tone: "muted",
      state: "disabled",
    });
  });

  it("returns ready when enabled and available", () => {
    expect(resolveMemoryVectorState({ enabled: true, available: true })).toEqual({
      tone: "ok",
      state: "ready",
    });
  });

  it("returns unavailable when enabled but not available", () => {
    expect(resolveMemoryVectorState({ enabled: true, available: false })).toEqual({
      tone: "warn",
      state: "unavailable",
    });
  });

  it("returns unknown when enabled and availability undefined", () => {
    expect(resolveMemoryVectorState({ enabled: true })).toEqual({
      tone: "muted",
      state: "unknown",
    });
  });
});

describe("resolveMemoryFtsState", () => {
  it("returns disabled when not enabled", () => {
    expect(resolveMemoryFtsState({ enabled: false, available: false })).toEqual({
      tone: "muted",
      state: "disabled",
    });
  });

  it("returns ready when enabled and available", () => {
    expect(resolveMemoryFtsState({ enabled: true, available: true })).toEqual({
      tone: "ok",
      state: "ready",
    });
  });

  it("returns unavailable when enabled but not available", () => {
    expect(resolveMemoryFtsState({ enabled: true, available: false })).toEqual({
      tone: "warn",
      state: "unavailable",
    });
  });
});

describe("resolveMemoryCacheSummary", () => {
  it("returns 'cache off' when disabled", () => {
    expect(resolveMemoryCacheSummary({ enabled: false })).toEqual({
      tone: "muted",
      text: "cache off",
    });
  });

  it("returns 'cache on' when enabled without entries", () => {
    expect(resolveMemoryCacheSummary({ enabled: true })).toEqual({ tone: "ok", text: "cache on" });
  });

  it("includes entry count when available", () => {
    expect(resolveMemoryCacheSummary({ enabled: true, entries: 42 })).toEqual({
      tone: "ok",
      text: "cache on (42)",
    });
  });
});

describe("resolveMemoryCacheState", () => {
  it("returns enabled", () => {
    expect(resolveMemoryCacheState({ enabled: true })).toEqual({ tone: "ok", state: "enabled" });
  });

  it("returns disabled", () => {
    expect(resolveMemoryCacheState({ enabled: false })).toEqual({
      tone: "muted",
      state: "disabled",
    });
  });
});
