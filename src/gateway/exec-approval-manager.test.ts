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

describe("ExecApprovalManager.resolveId", () => {
  it("returns exact match", () => {
    const manager = createManagerWithEntries("aaaa-1111", "bbbb-2222");
    const result = manager.resolveId("aaaa-1111");
    expect(result).toEqual({ id: "aaaa-1111" });
  });

  it("resolves unique prefix", () => {
    const manager = createManagerWithEntries("aaaa-1111-cccc", "bbbb-2222-dddd");
    const result = manager.resolveId("aaaa");
    expect(result).toEqual({ id: "aaaa-1111-cccc" });
  });

  it("returns ambiguous when multiple entries share prefix", () => {
    const manager = createManagerWithEntries("aaaa-1111", "aaaa-2222");
    const result = manager.resolveId("aaaa");
    expect(result).toEqual({ ambiguous: ["aaaa-1111", "aaaa-2222"] });
  });

  it("returns null for no match", () => {
    const manager = createManagerWithEntries("aaaa-1111");
    const result = manager.resolveId("zzzz");
    expect(result).toBeNull();
  });

  it("prefers exact match over prefix scan", () => {
    const manager = createManagerWithEntries("abc", "abcdef");
    const result = manager.resolveId("abc");
    expect(result).toEqual({ id: "abc" });
  });

  it("returns null for empty pending map", () => {
    vi.useFakeTimers();
    const manager = new ExecApprovalManager();
    expect(manager.resolveId("anything")).toBeNull();
  });
});
