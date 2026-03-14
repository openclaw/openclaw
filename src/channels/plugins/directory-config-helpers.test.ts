import { describe, expect, it } from "vitest";
import {
  listDirectoryGroupEntriesFromMapKeysAndAllowFrom,
  listDirectoryGroupEntriesFromMapKeys,
  listDirectoryUserEntriesFromAllowFromAndMapKeys,
  listDirectoryUserEntriesFromAllowFrom,
} from "./directory-config-helpers.js";

function expectUserDirectoryEntries(entries: unknown) {
  expect(entries).toEqual([
    { kind: "user", id: "alice" },
    { kind: "user", id: "carla" },
  ]);
}

describe("listDirectoryUserEntriesFromAllowFrom", () => {
  it("normalizes, deduplicates, filters, and limits user ids", () => {
    const entries = listDirectoryUserEntriesFromAllowFrom({
      allowFrom: ["", "*", "  user:Alice ", "user:alice", "user:Bob", "user:Carla"],
      normalizeId: (entry) => entry.replace(/^user:/i, "").toLowerCase(),
      query: "a",
      limit: 2,
    });

    expectUserDirectoryEntries(entries);
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

describe("listDirectoryUserEntriesFromAllowFromAndMapKeys", () => {
  it("merges allowFrom and map keys with dedupe/query/limit", () => {
    const entries = listDirectoryUserEntriesFromAllowFromAndMapKeys({
      allowFrom: ["user:alice", "user:bob"],
      map: {
        "user:carla": {},
        "user:alice": {},
      },
      normalizeAllowFromId: (entry) => entry.replace(/^user:/i, ""),
      normalizeMapKeyId: (entry) => entry.replace(/^user:/i, ""),
      query: "a",
      limit: 2,
    });

    expectUserDirectoryEntries(entries);
  });
});

describe("listDirectoryGroupEntriesFromMapKeysAndAllowFrom", () => {
  it("merges groups keys and group allowFrom entries", () => {
    const entries = listDirectoryGroupEntriesFromMapKeysAndAllowFrom({
      groups: {
        "team/a": {},
      },
      allowFrom: ["team/b", "team/a"],
      query: "team/",
    });

    expect(entries).toEqual([
      { kind: "group", id: "team/a" },
      { kind: "group", id: "team/b" },
    ]);
  });
});
