import { describe, expect, it } from "vitest";
import { resolveMemoryFtsState, resolveMemoryVectorState } from "./status-format.js";

describe("status-format", () => {
  describe("resolveMemoryVectorState", () => {
    it("returns disabled when vector search is disabled", () => {
      expect(resolveMemoryVectorState({ enabled: false })).toEqual({
        tone: "muted",
        state: "disabled",
      });
    });

    it("returns ready when vector search is available", () => {
      expect(resolveMemoryVectorState({ enabled: true, available: true })).toEqual({
        tone: "ok",
        state: "ready",
      });
    });

    it("returns unavailable when vector search is explicitly unavailable", () => {
      expect(resolveMemoryVectorState({ enabled: true, available: false })).toEqual({
        tone: "warn",
        state: "unavailable",
      });
    });

    it("returns unknown when availability is not provided", () => {
      expect(resolveMemoryVectorState({ enabled: true })).toEqual({
        tone: "muted",
        state: "unknown",
      });
    });
  });

  describe("resolveMemoryFtsState", () => {
    it("returns disabled when FTS is disabled", () => {
      expect(resolveMemoryFtsState({ enabled: false, available: true })).toEqual({
        tone: "muted",
        state: "disabled",
      });
    });

    it("returns ready when FTS is enabled and available", () => {
      expect(resolveMemoryFtsState({ enabled: true, available: true })).toEqual({
        tone: "ok",
        state: "ready",
      });
    });

    it("returns unavailable when FTS is enabled but unavailable", () => {
      expect(resolveMemoryFtsState({ enabled: true, available: false })).toEqual({
        tone: "warn",
        state: "unavailable",
      });
    });
  });
});
