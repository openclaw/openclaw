import { beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import {
  collectDatabaseEngineHealthFindings,
  noteDatabaseEngines,
} from "./doctor-database-engine.js";

vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note: vi.fn(),
}));

beforeEach(() => vi.mocked(note).mockClear());

describe("Doctor database engines", () => {
  it("reports default SQLite store families without an experimental warning", () => {
    noteDatabaseEngines({});
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Shared state: sqlite\nAgent data: sqlite\nWorkboard: sqlite"),
      "Database engines",
    );
    expect(vi.mocked(note).mock.calls[0]?.[0]).not.toContain("experimental");
    expect(collectDatabaseEngineHealthFindings({})).toEqual([]);
  });

  it("reports selected and unported engines with one actionable warning", () => {
    const cfg = { database: { engine: "postgres" as const } };
    noteDatabaseEngines(cfg);
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Shared state: sqlite\nAgent data: sqlite\nWorkboard: postgres"),
      "Database engines",
    );
    const output = String(vi.mocked(note).mock.calls[0]?.[0]);
    expect(output).toContain("Logbook: postgres");
    expect(output.match(/experimental/g)).toHaveLength(1);
    expect(output).toContain("Stores without a registered PostgreSQL schema remain on SQLite");
    expect(collectDatabaseEngineHealthFindings(cfg)).toEqual([
      expect.objectContaining({
        severity: "warning",
        path: "database.engine",
        fixHint: expect.stringContaining("/reference/database-engines"),
      }),
    ]);
  });
});
