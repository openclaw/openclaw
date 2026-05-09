import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { assertSqliteIntegrityOk, readSqliteIntegrityCheck } from "./sqlite-integrity.js";

function createMockDb(row: unknown): DatabaseSync {
  return {
    prepare: vi.fn(() => ({
      get: vi.fn(() => row),
    })),
  } as unknown as DatabaseSync;
}

describe("sqlite integrity helpers", () => {
  it("reads sqlite integrity_check results", () => {
    expect(readSqliteIntegrityCheck(createMockDb({ integrity_check: "ok" }))).toBe("ok");
    expect(readSqliteIntegrityCheck(createMockDb({ integrity_check: 1 }))).toBe("1");
  });

  it("throws when sqlite integrity_check is not ok", () => {
    expect(() =>
      assertSqliteIntegrityOk(createMockDb({ integrity_check: "malformed" }), "bad db"),
    ).toThrow("bad db");
  });
});
