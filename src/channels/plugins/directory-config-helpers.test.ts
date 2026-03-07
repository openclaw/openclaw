import { describe, expect, it } from "vitest";
import {
  listDirectoryGroupEntriesFromMapKeys,
  listDirectoryUserEntriesFromAllowFrom,
} from "./directory-config-helpers.js";

describe("listDirectoryUserEntriesFromAllowFrom", () => {
  it("normalizes, deduplicates, filters, and limits user ids", () => {
    const entries = listDirectoryUserEntriesFromAllowFrom({
      allowFrom: ["", "*", "  user:Alice ", "user:alice", "user:Bob", "user:Carla"],
      normalizeId: (entry) => entry.replace(/^user:/i, "").toLowerCase(),
      query: "a",
      limit: 2,
    });

    expect(entries).toEqual([
      { kind: "user", id: "alice" },
      { kind: "user", id: "carla" },
    ]);
  });
});

describe("listDirectoryGroupEntriesFromMapKeys", () => {
  it("extracts normalized group ids from map keys", () => {
    const entries = listDirectoryGroupEntriesFromMapKeys({
      groups: {
        "*": {},
        " Space/A ": {},
        "space/b": {},
      },
      normalizeId: (entry) => entry.toLowerCase().replace(/\s+/g, ""),
    });

    expect(entries).toEqual([
      { kind: "group", id: "space/a" },
      { kind: "group", id: "space/b" },
    ]);
  });
});
