import { describe, expect, it } from "vitest";
import { entityMatches, extractEntities } from "./entity-extract.js";

describe("entity extract", () => {
  it("extracts @tags", () => {
    expect(extractEntities("@Peter mentioned something")).toEqual(["Peter"]);
  });

  it("extracts bold entities", () => {
    expect(extractEntities("**Market Signals** project")).toEqual(["Market Signals"]);
  });

  it("extracts heading entities", () => {
    expect(extractEntities("## Trading Decisions\nSome text")).toEqual(["Trading Decisions"]);
  });

  it("extracts mixed entities and skips non-entities", () => {
    expect(extractEntities("@peter and @sarah discussed **Important Project**")).toEqual([
      "peter",
      "sarah",
      "Important Project",
    ]);
    expect(extractEntities("**Note**: this is **TODO**")).toEqual([]);
  });

  it("returns empty for empty/no-entity text", () => {
    expect(extractEntities("")).toEqual([]);
    expect(extractEntities("No entity here")).toEqual([]);
  });
});

describe("entity matches", () => {
  it("matches case-insensitively", () => {
    expect(entityMatches(["Peter", "Sarah"], "peter")).toBe(true);
    expect(entityMatches(["Peter", "Sarah"], "john")).toBe(false);
  });

  it("matches partial queries", () => {
    expect(entityMatches(["Market Signals"], "market")).toBe(true);
    expect(entityMatches([], "anything")).toBe(false);
  });
});
