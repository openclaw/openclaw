import { describe, expect, it } from "vitest";
import {
  mapBasicAllowlistResolutionEntries,
  type BasicAllowlistResolutionEntry,
} from "./allowlist-resolution.js";

describe("mapBasicAllowlistResolutionEntries", () => {
  it("maps entries to normalized allowlist resolver output", () => {
    const entries: BasicAllowlistResolutionEntry[] = [
      {
        input: "alice",
        resolved: true,
        id: "U123",
        name: "Alice",
        note: "ok",
      },
      {
        input: "bob",
        resolved: false,
      },
    ];

    expect(mapBasicAllowlistResolutionEntries(entries)).toEqual([
      {
        input: "alice",
        resolved: true,
        id: "U123",
        name: "Alice",
        note: "ok",
      },
      {
        input: "bob",
        resolved: false,
        id: undefined,
        name: undefined,
        note: undefined,
      },
    ]);
  });
});
