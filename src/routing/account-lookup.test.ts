import { describe, expect, it } from "vitest";
import { resolveAccountEntry, resolveNormalizedAccountEntry } from "./account-lookup.js";

describe("resolveAccountEntry", () => {
  it("returns entry for exact match", () => {
    const accounts = { user1: { name: "User 1" }, user2: { name: "User 2" } };
    expect(resolveAccountEntry(accounts, "user1")).toEqual({ name: "User 1" });
  });

  it("returns undefined for non-existent account", () => {
    const accounts = { user1: {} };
    expect(resolveAccountEntry(accounts, "nonexistent")).toBeUndefined();
  });

  it("falls back to case-insensitive match", () => {
    const accounts = { User1: { name: "User 1" } };
    expect(resolveAccountEntry(accounts, "user1")).toEqual({ name: "User 1" });
    expect(resolveAccountEntry(accounts, "USER1")).toEqual({ name: "User 1" });
  });

  it("returns undefined for undefined accounts", () => {
    expect(resolveAccountEntry(undefined, "user1")).toBeUndefined();
  });

  it("returns undefined for null accounts", () => {
    expect(resolveAccountEntry(null as any, "user1")).toBeUndefined();
  });

  it("returns undefined for non-object accounts", () => {
    expect(resolveAccountEntry("string" as any, "user1")).toBeUndefined();
    expect(resolveAccountEntry([] as any, "user1")).toBeUndefined();
  });
});

describe("resolveNormalizedAccountEntry", () => {
  const mockNormalize = (id: string) => id.toLowerCase();

  it("returns entry for exact match", () => {
    const accounts = { user1: { name: "User 1" } };
    expect(resolveNormalizedAccountEntry(accounts, "user1", mockNormalize)).toEqual({ name: "User 1" });
  });

  it("uses custom normalize function", () => {
    const accounts = { "USER-1": { name: "User 1" } };
    const normalize = (id: string) => id.toLowerCase().replace("-", "");
    expect(resolveNormalizedAccountEntry(accounts, "user1", normalize)).toEqual({ name: "User 1" });
  });

  it("returns undefined for non-existent account", () => {
    const accounts = { user1: {} };
    const normalize = (id: string) => id;
    expect(resolveNormalizedAccountEntry(accounts, "user2", normalize)).toBeUndefined();
  });

  it("returns undefined for undefined accounts", () => {
    expect(resolveNormalizedAccountEntry(undefined, "user1", mockNormalize)).toBeUndefined();
  });
});
