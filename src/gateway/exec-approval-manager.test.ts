import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecApprovalManager } from "./exec-approval-manager.js";

afterEach(() => {
  vi.useRealTimers();
});

function createManagerWithEntries(...ids: string[]) {
  vi.useFakeTimers();
  const manager = new ExecApprovalManager();
  for (const id of ids) {
    const record = manager.create({ command: "echo test" }, 60_000, id);
    void manager.register(record, 60_000);
  }
  return manager;
}

describe("ExecApprovalManager.lookupPendingId", () => {
  it("returns exact match", () => {
    const manager = createManagerWithEntries("aaaa-1111", "bbbb-2222");
    const result = manager.lookupPendingId("aaaa-1111");
    expect(result).toEqual({ kind: "exact", id: "aaaa-1111" });
  });

  it("resolves unique prefix", () => {
    const manager = createManagerWithEntries("aaaa-1111-cccc", "bbbb-2222-dddd");
    const result = manager.lookupPendingId("aaaa");
    expect(result).toEqual({ kind: "prefix", id: "aaaa-1111-cccc" });
  });

  it("returns ambiguous when multiple entries share prefix", () => {
    const manager = createManagerWithEntries("aaaa-1111", "aaaa-2222");
    const result = manager.lookupPendingId("aaaa");
    expect(result).toEqual({ kind: "ambiguous", ids: ["aaaa-1111", "aaaa-2222"] });
  });

  it("returns none for no match", () => {
    const manager = createManagerWithEntries("aaaa-1111");
    expect(manager.lookupPendingId("zzzz")).toEqual({ kind: "none" });
  });

  it("prefers exact match over prefix scan", () => {
    const manager = createManagerWithEntries("abc", "abcdef");
    const result = manager.lookupPendingId("abc");
    expect(result).toEqual({ kind: "exact", id: "abc" });
  });

  it("returns none for empty pending map", () => {
    vi.useFakeTimers();
    const manager = new ExecApprovalManager();
    expect(manager.lookupPendingId("anything")).toEqual({ kind: "none" });
  });

  it("skips resolved entries in grace period during prefix scan", () => {
    const manager = createManagerWithEntries("aaaa-1111", "aaaa-2222");
    manager.resolve("aaaa-1111", "allow-once");
    const result = manager.lookupPendingId("aaaa");
    expect(result).toEqual({ kind: "prefix", id: "aaaa-2222" });
  });

  it("returns none for exact match that is already resolved (grace period)", () => {
    const manager = createManagerWithEntries("aaaa-1111");
    manager.resolve("aaaa-1111", "allow-once");
    expect(manager.lookupPendingId("aaaa-1111")).toEqual({ kind: "none" });
  });

  it("returns none (not extension) when exact ID is in grace period and extension exists", () => {
    const manager = createManagerWithEntries("req-1", "req-10");
    manager.resolve("req-1", "allow-once");
    expect(manager.lookupPendingId("req-1")).toEqual({ kind: "none" });
  });

  it("supports case-insensitive prefix matching", () => {
    const manager = createManagerWithEntries("AaBb-1111");
    const result = manager.lookupPendingId("aabb");
    expect(result).toEqual({ kind: "prefix", id: "AaBb-1111" });
  });

  it("returns none for empty input", () => {
    const manager = createManagerWithEntries("aaaa-1111");
    expect(manager.lookupPendingId("")).toEqual({ kind: "none" });
    expect(manager.lookupPendingId("  ")).toEqual({ kind: "none" });
  });
});
