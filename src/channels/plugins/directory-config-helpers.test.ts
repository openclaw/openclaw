import { describe, expect, it } from "vitest";
import {
  createInspectedDirectoryEntriesLister,
  createResolvedDirectoryEntriesLister,
  listInspectedDirectoryEntriesFromSources,
  listDirectoryGroupEntriesFromMapKeysAndAllowFrom,
  listDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryUserEntriesFromAllowFrom,
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

  const resolveAccount = () => ({
    allowFrom: ["user:alice", "user:bob"],
    groups: { "room:a": {}, "room:b": {} },
  });

  it("lists user entries from resolved account allowFrom", () => {
    const entries = listResolvedDirectoryUserEntriesFromAllowFrom({
      cfg,
      resolveAccount,
      resolveAllowFrom: (account) => account.allowFrom,
      normalizeId: stripUser,
      query: "a",
    });

    expect(entries).toEqual([{ kind: "user", id: "alice" }]);
  });

  it("lists group entries from resolved account map keys", () => {
    const entries = listResolvedDirectoryGroupEntriesFromMapKeys({
      cfg,
      resolveAccount,
      resolveGroups: (account) => account.groups,
      normalizeId: stripRoom,
    });

    expect(entries).toEqual(groups("a", "b"));
  });

  it("builds a reusable resolved-account lister", async () => {
    const listUsers = createResolvedDirectoryEntriesLister({
      kind: "user",
      resolveAccount,
      resolveSources: (account) => [account.allowFrom, ["user:carla", "user:alice"]],
      normalizeId: stripUser,
    });

    await expect(listUsers({ cfg, query: "a", limit: 2 })).resolves.toEqual(users);
  });
});
