import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { ensureSqliteLibrarySelected } from "../infra/bun-sqlite-library.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as engineInspection from "./doctor-database-engine-inspection.js";
import {
  collectDoctorDatabaseEngineHealthFindings,
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
  vi.spyOn(engineInspection, "inspectDoctorDatabaseEngines").mockResolvedValue({
    observed: {},
    stateRoots: [],
    discoveryFailed: false,
  });
  vi.mocked(ensureSqliteLibrarySelected).mockReturnValue({ source: "runtime" });
});

describe("Doctor database engines", () => {
  it("reports default SQLite store families without an experimental warning", async () => {
    const findings = await noteDatabaseEngines({});
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "Shared state: default=sqlite, override=inherit, effective=sqlite (configured)",
      ),
      "Database engines",
    );
    expect(vi.mocked(note).mock.calls[0]?.[0]).not.toContain("experimental");
    expect(findings).toEqual([]);
  });

  it("reports supported PostgreSQL selections without a blanket warning", async () => {
    const cfg = { database: { engine: "postgres" as const } };
    const findings = await noteDatabaseEngines(cfg);
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
    expect(output).not.toContain("experimental");
    expect(findings).toEqual([]);
  });

  it("reports supported mixed overrides with a SQLite default", async () => {
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
    const findings = await noteDatabaseEngines(cfg);
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
    expect(findings).toEqual([]);
  });

  it("distinguishes configured choices from conflicting physical stores without exposing connection details", async () => {
    const cfg = {
      database: {
        families: { workboard: { engine: "postgres" as const } },
        postgres: { connection: "postgres://fixture:secret@host/database" },
      },
    };
    const observed = { workboard: ["sqlite" as const], state: ["sqlite" as const] };
    vi.mocked(engineInspection.inspectDoctorDatabaseEngines).mockResolvedValue({
      observed,
      stateRoots: [],
      discoveryFailed: false,
    });
    const findings = await noteDatabaseEngines(cfg);
    const output = String(vi.mocked(note).mock.calls[0]?.[0]);
    expect(output).toContain(
      "Workboard: default=sqlite, override=postgres, effective=postgres (configured); observed=sqlite",
    );
    expect(output).not.toContain("secret");
    expect(findings).toEqual([
      expect.objectContaining({
        path: "database.families.workboard.engine",
        message: expect.stringContaining("configured postgres, observed sqlite"),
        fixHint: expect.stringContaining("database port --family workboard"),
      }),
    ]);
  });

  it.each(["bundled", "env", "discovered"] as const)(
    "reports the %s SQLite library independently of Gateway service inspection",
    async (source) => {
      vi.mocked(ensureSqliteLibrarySelected).mockReturnValue({
        source,
        path: "/isolated/runtime/lib/libsqlite3.dylib",
        version: "3.53.4",
        extensionLoadingSupported: true,
      });
      await noteDatabaseEngines({});
      expect(note).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          "SQLite (doctor process): /isolated/runtime/lib/libsqlite3.dylib (3.53.4, extension loading enabled)",
        ),
        "Database engines",
      );
    },
  );

  it("explains a SQLite override ignored by the current runtime", async () => {
    vi.mocked(ensureSqliteLibrarySelected).mockReturnValue({
      source: "runtime",
      ignoredOverride: "OPENCLAW_SQLITE_LIBRARY requires Bun on macOS",
    });
    await noteDatabaseEngines({});
    expect(note).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        "SQLite (doctor process): OPENCLAW_SQLITE_LIBRARY requires Bun on macOS; override ignored",
      ),
      "Database engines",
    );
  });

  it("lists retained account and token roots with physical engines and selected-state mismatches", async () => {
    vi.mocked(engineInspection.inspectDoctorDatabaseEngines).mockRestore();
    await withOpenClawTestState(
      { scenario: "minimal", prefix: "doctor-state-roots-" },
      async (state) => {
        await fs.mkdir(state.path("plugin"));
        const plugin = createColdPluginFixture({
          rootDir: state.path("plugin"),
          pluginId: "account-owner",
          manifest: {
            backupResources: [
              {
                scope: "state",
                relativePath: "matrix",
                disposition: "include",
                databaseFamily: "state",
              },
            ],
          },
        });
        const roots = [
          ["active", "1111111111111111"],
          ["active", "2222222222222222"],
          ["disabled", "3333333333333333"],
        ].map(([account, token]) =>
          state.statePath(
            "matrix",
            "accounts",
            account!,
            "server__user",
            token!,
            "state",
            "openclaw.sqlite",
          ),
        );
        for (const [index, file] of roots.entries()) {
          await fs.mkdir(path.dirname(file), { recursive: true });
          using db = openNodeSqliteDatabase(file);
          if (index === 2) {
            db.exec(
              "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
            );
            db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run(
              "317d2b20-1a1e-4ad9-a4b0-e884ce3a3c00",
              "matrix_retained",
            );
          } else {
            db.exec("CREATE TABLE retained (value TEXT)");
          }
        }
        const config = {
          database: {
            families: { workboard: { engine: "postgres" as const } },
            postgres: { connection: "postgresql://unused.example.invalid/doctor-fixture" },
          },
          plugins: { enabled: false, load: { paths: [plugin.rootDir] } },
        };
        await state.writeConfig(config);
        const findings = await noteDatabaseEngines(config, { env: state.env });
        const output = String(vi.mocked(note).mock.calls[0]?.[0]);
        for (const file of roots.slice(0, 2)) {
          expect(output).toContain(`Shared state root: ${file} (physical=sqlite)`);
        }
        expect(output).toContain(
          `Shared state root: ${roots[2]} (physical=postgres, namespace=matrix_retained)`,
        );
        expect(findings.filter((finding) => finding.message.includes("engine mismatch"))).toEqual([
          expect.objectContaining({
            path: roots[2],
            message: expect.stringContaining("configured=sqlite"),
          }),
        ]);
        const postgresFindings = (
          await collectDoctorDatabaseEngineHealthFindings(
            {
              ...config,
              database: {
                families: { state: { engine: "postgres" } },
                postgres: { connection: "postgresql://unused.example.invalid/doctor-fixture" },
              },
            },
            { env: state.env },
          )
        ).filter((finding) => finding.message.includes("engine mismatch"));
        expect(
          postgresFindings
            .map((finding) => finding.path)
            .toSorted((left, right) => String(left).localeCompare(String(right))),
        ).toEqual(roots.slice(0, 2).toSorted());
        expect(
          postgresFindings.every((finding) => finding.message.includes("configured=postgres")),
        ).toBe(true);
        expect(await fs.stat(plugin.runtimeMarker).catch(() => undefined)).toBeUndefined();
      },
    );
  });

  it("reports inventory failures without exposing connection details or aborting Doctor", async () => {
    vi.mocked(engineInspection.inspectDoctorDatabaseEngines).mockResolvedValue({
      observed: {},
      stateRoots: [],
      discoveryFailed: true,
    });
    const findings = await noteDatabaseEngines({});
    expect(findings).toEqual([
      expect.objectContaining({
        message: "Database roots could not all be inspected.",
        fixHint: expect.stringContaining("rerun openclaw doctor"),
      }),
    ]);
    expect(String(vi.mocked(note).mock.calls[0]?.[0])).not.toContain("private-");
  });
});
