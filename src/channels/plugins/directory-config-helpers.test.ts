import { describe, expect, it } from "vitest";
import {
  createInspectedDirectoryEntriesLister,
  listInspectedDirectoryEntriesFromSources,
  listDirectoryGroupEntriesFromMapKeysAndAllowFrom,
  listDirectoryGroupEntriesFromMapKeys,
  listDirectoryUserEntriesFromAllowFromAndMapKeys,
  listDirectoryUserEntriesFromAllowFrom,
} from "./directory-config-helpers.js";

const users = [
  { kind: "user", id: "alice" },
  { kind: "user", id: "carla" },
];
const stripUser = (entry: string) => entry.replace(/^user:/i, "");
const stripRoom = (entry: string) => entry.replace(/^room:/i, "");
const cfg = {};
const groups = (...ids: string[]) => ids.map((id) => ({ kind: "group", id }));

describe("directory config helpers", () => {
  it("normalizes, deduplicates, filters, and limits user ids", () => {
    const entries = listDirectoryUserEntriesFromAllowFrom({
      allowFrom: ["", "*", "  user:Alice ", "user:alice", "user:Bob", "user:Carla"],
      normalizeId: (entry) => stripUser(entry).toLowerCase(),
      query: "a",
      limit: 2,
    });

    expect(entries).toEqual(users);
  });

  it("extracts normalized group ids from map keys", () => {
    const entries = listDirectoryGroupEntriesFromMapKeys({
      groups: { "*": {}, " Space/A ": {}, "space/b": {} },
      normalizeId: (entry) => entry.toLowerCase().replace(/\s+/g, ""),
    });

    expect(entries).toEqual(groups("space/a", "space/b"));
  });

  it("merges allowFrom and map keys with dedupe/query/limit", () => {
    const entries = listDirectoryUserEntriesFromAllowFromAndMapKeys({
      allowFrom: ["user:alice", "user:bob"],
      map: { "user:carla": {}, "user:alice": {} },
      normalizeAllowFromId: stripUser,
      normalizeMapKeyId: stripUser,
      query: "a",
      limit: 2,
    });

    expect(entries).toEqual(users);
  });

  it("merges groups keys and group allowFrom entries", () => {
    const entries = listDirectoryGroupEntriesFromMapKeysAndAllowFrom({
      groups: { "team/a": {} },
      allowFrom: ["team/b", "team/a"],
      query: "team/",
    });

    expect(entries).toEqual(groups("team/a", "team/b"));
  });

  it("returns empty when the inspected account is missing", () => {
    const entries = listInspectedDirectoryEntriesFromSources({
      cfg,
      kind: "user",
      inspectAccount: () => null,
      resolveSources: () => [["user:alice"]],
      normalizeId: stripUser,
    });

    expect(entries).toStrictEqual([]);
  });

  it("builds a reusable inspected-account lister", async () => {
    const listGroups = createInspectedDirectoryEntriesLister({
      kind: "group",
      inspectAccount: () => ({ ids: [["room:a"], ["room:b", "room:a"]] }),
      resolveSources: (account) => account.ids,
      normalizeId: stripRoom,
    });

    await expect(listGroups({ cfg, query: "a" })).resolves.toEqual(groups("a"));
  });
});
