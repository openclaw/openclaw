import { beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { ensureSqliteLibrarySelected } from "../infra/bun-sqlite-library.js";
import {
  collectDatabaseEngineHealthFindings,
  noteDatabaseEngines,
} from "./doctor-database-engine.js";

vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note: vi.fn(),
}));

vi.mock("../infra/bun-sqlite-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/bun-sqlite-library.js")>()),
  ensureSqliteLibrarySelected: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(note).mockClear();
  vi.mocked(ensureSqliteLibrarySelected).mockReturnValue({ source: "runtime" });
});

describe("Doctor database engines", () => {
  it("reports default SQLite store families without an experimental warning", () => {
    noteDatabaseEngines({});
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "Shared state: default=sqlite, override=inherit, effective=sqlite (configured)",
      ),
      "Database engines",
    );
    expect(vi.mocked(note).mock.calls[0]?.[0]).not.toContain("experimental");
    expect(collectDatabaseEngineHealthFindings({})).toEqual([]);
  });

  it("reports selected and unported engines with one actionable warning", () => {
    const cfg = { database: { engine: "postgres" as const } };
    noteDatabaseEngines(cfg);
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "Shared state: default=postgres, override=inherit, effective=postgres (configured)",
      ),
      "Database engines",
    );
    const output = String(vi.mocked(note).mock.calls[0]?.[0]);
    expect(output).toContain(
      "Agent data: default=postgres, override=inherit, effective=postgres (configured)",
    );
    expect(output).toContain(
      "Logbook: default=postgres, override=inherit, effective=postgres (configured)",
    );
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

  it("reports mixed overrides and warns even with a SQLite default", () => {
    const cfg = {
      database: {
        engine: "sqlite" as const,
        families: {
          state: { engine: "postgres" as const },
          agent: { engine: "sqlite" as const },
          workboard: { engine: "postgres" as const },
        },
      },
    };
    noteDatabaseEngines(cfg);
    const output = String(vi.mocked(note).mock.calls[0]?.[0]);
    expect(output).toContain(
      "Workboard: default=sqlite, override=postgres, effective=postgres (configured)",
    );
    expect(output).toContain(
      "Agent data: default=sqlite, override=sqlite, effective=sqlite (configured)",
    );
    expect(output).toContain(
      "Database quarantine: default=sqlite, override=fixed local, effective=sqlite (configured)",
    );
    expect(collectDatabaseEngineHealthFindings(cfg)).toHaveLength(1);
  });

  it.each(["bundled", "env", "discovered"] as const)(
    "reports the %s SQLite library independently of Gateway service inspection",
    (source) => {
      vi.mocked(ensureSqliteLibrarySelected).mockReturnValue({
        source,
        path: "/isolated/runtime/lib/libsqlite3.dylib",
        version: "3.53.4",
        extensionLoadingSupported: true,
      });
      noteDatabaseEngines({});
      expect(note).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          "SQLite (doctor process): /isolated/runtime/lib/libsqlite3.dylib (3.53.4, extension loading enabled)",
        ),
        "Database engines",
      );
    },
  );

  it("explains a SQLite override ignored by the current runtime", () => {
    vi.mocked(ensureSqliteLibrarySelected).mockReturnValue({
      source: "runtime",
      ignoredOverride: "OPENCLAW_SQLITE_LIBRARY requires Bun on macOS",
    });
    noteDatabaseEngines({});
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "SQLite (doctor process): OPENCLAW_SQLITE_LIBRARY requires Bun on macOS; override ignored",
      ),
      "Database engines",
    );
  });
});
