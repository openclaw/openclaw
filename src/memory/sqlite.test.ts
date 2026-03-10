import { beforeEach, describe, expect, it, vi } from "vitest";
import { installProcessWarningFilter } from "../infra/warning-filter.js";
import { requireNodeSqlite } from "./sqlite.js";

const { requireBuiltinMock, createRequireMock } = vi.hoisted(() => {
  const requireBuiltinMock = vi.fn();
  const createRequireMock = vi.fn(() => requireBuiltinMock);
  return { requireBuiltinMock, createRequireMock };
});

vi.mock("node:module", () => ({
  createRequire: createRequireMock,
}));

vi.mock("../infra/warning-filter.js", () => ({
  installProcessWarningFilter: vi.fn(),
}));

describe("requireNodeSqlite", () => {
  const installProcessWarningFilterMock = vi.mocked(installProcessWarningFilter);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the node:sqlite module when available", () => {
    const sqliteModule = {
      DatabaseSync: class DatabaseSync {},
    } as unknown as typeof import("node:sqlite");
    requireBuiltinMock.mockReturnValueOnce(sqliteModule);

    const result = requireNodeSqlite();

    expect(result).toBe(sqliteModule);
    expect(installProcessWarningFilterMock).toHaveBeenCalledTimes(1);
    expect(requireBuiltinMock).toHaveBeenCalledWith("node:sqlite");
  });

  it("wraps require errors with actionable message", () => {
    const cause = new Error("No such built-in module: node:sqlite");
    requireBuiltinMock.mockImplementationOnce(() => {
      throw cause;
    });

    let thrown: unknown;
    try {
      requireNodeSqlite();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "SQLite support is unavailable in this Node runtime (missing node:sqlite)",
    );
    expect((thrown as Error & { cause?: unknown }).cause).toBe(cause);
  });

  it("handles non-Error throw values", () => {
    requireBuiltinMock.mockImplementationOnce(() => {
      throw "missing module";
    });

    expect(() => requireNodeSqlite()).toThrow(
      "SQLite support is unavailable in this Node runtime (missing node:sqlite). missing module",
    );
  });
});
