import "../snapshot/database-backup.js";
import "./backup-sqlite-snapshot.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { assertUpdateDatabaseEngineContexts } from "./update-database-engine-admission.js";

vi.mock("../snapshot/database-backup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../snapshot/database-backup.js")>()),
  readPostgresBackupFamily: vi.fn(async () => "workboard"),
}));

const directories = useAutoCleanupTempDirTracker(afterEach);
const engines = ["sqlite", "postgres"];
const families = ["state", "agent", "workboard", "logbook", "team-reports"];
type Context = Parameters<typeof assertUpdateDatabaseEngineContexts>[0][number];

function withDatabase(context: Context, database: OpenClawConfig["database"]): Context {
  return {
    ...context,
    config: {
      ...context.config,
      database: {
        ...database,
        postgres: { connection: "postgresql://synthetic.invalid/update-admission" },
      },
    },
  };
}

async function unchanged(file: string, action: () => Promise<unknown>) {
  const before = await fs.readFile(file);
  await action();
  expect(await fs.readFile(file)).toEqual(before);
}

async function store(engine: "sqlite" | "postgres", enabled = true) {
  const stateDir = directories.make("update-engine-admission-");
  const file = path.join(stateDir, "plugins", "workboard", "workboard.sqlite");
  await fs.mkdir(path.dirname(file), { recursive: true });
  using db = openNodeSqliteDatabase(file);
  if (engine === "postgres") {
    db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
    db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, ?, ?)").run(
      "e3b4e990-c0f1-4ec7-a5d1-4e1c6824f80f",
      "postgres",
      "retained_workboard",
    );
  } else {
    db.exec("CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('retained')");
  }
  return {
    file,
    context: {
      config: { plugins: { entries: { workboard: { enabled } } } },
      env: { OPENCLAW_STATE_DIR: stateDir },
    },
  };
}

it.each([
  { declaration: undefined },
  { declaration: ["sqlite"] },
  { declaration: [] },
  { declaration: "postgres" },
])(
  "refuses an unsupported PostgreSQL target before mutation: $declaration",
  async ({ declaration }) => {
    const { file, context } = await store("postgres");
    const before = await fs.readFile(file);
    const activate = vi.fn();
    await expect(
      assertUpdateDatabaseEngineContexts([context], declaration).then(activate),
    ).rejects.toThrow(/Reverse-port to SQLite with the current binary/);
    expect(activate).not.toHaveBeenCalled();
    expect(await fs.readFile(file)).toEqual(before);
    expect(await fs.readdir(path.dirname(file))).toEqual(["workboard.sqlite"]);
  },
);

it("admits a matching PostgreSQL target without changing its anchor", async () => {
  const { file, context } = await store("postgres");
  await unchanged(file, () =>
    assertUpdateDatabaseEngineContexts([context], engines, ["workboard"]),
  );
});

it.each(["sqlite", "postgres"] as const)(
  "reads a legacy registry before deciding whether its retained %s agent prevents downgrade",
  async (engine) => {
    const { context } = await store("sqlite");
    const registry = path.join(context.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
    const retained = path.join(directories.make("retained-agent-engine-"), "agent.sqlite");
    await fs.mkdir(path.dirname(registry), { recursive: true });
    {
      using db = openNodeSqliteDatabase(retained);
      if (engine === "postgres") {
        db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
        db.prepare(
          "INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', 'retained_agent')",
        ).run("e3b4e990-c0f1-4ec7-a5d1-4e1c6824f80f");
      } else {
        db.exec("CREATE TABLE payload(value TEXT); INSERT INTO payload VALUES ('retained')");
      }
      using shared = openNodeSqliteDatabase(registry);
      shared.exec("PRAGMA user_version=17; CREATE TABLE agent_databases(path TEXT)");
      shared.prepare("INSERT INTO agent_databases VALUES (?)").run(retained);
    }
    const before = await Promise.all([fs.readFile(registry), fs.readFile(retained)]);
    const inspection = assertUpdateDatabaseEngineContexts([context], undefined);
    if (engine === "postgres") {
      await expect(inspection).rejects.toThrow(retained);
    } else {
      await inspection;
    }
    expect(await Promise.all([fs.readFile(registry), fs.readFile(retained)])).toEqual(before);
  },
);

it.each([
  { engine: "sqlite", families: { workboard: { engine: "postgres" } } },
  {
    engine: "postgres",
    families: { agent: { engine: "sqlite" }, workboard: { engine: "sqlite" } },
  },
  { engine: "sqlite", families: { state: { engine: "postgres" } } },
  { engine: "sqlite", families: { agent: { engine: "sqlite" } } },
] satisfies NonNullable<OpenClawConfig["database"]>[])(
  "admits selected mixed families without changing store bytes (%j)",
  async (database) => {
    const { file, context } = await store("sqlite");
    await unchanged(file, () =>
      assertUpdateDatabaseEngineContexts([withDatabase(context, database)], engines, families),
    );
  },
);

it("checks every context for its selected PostgreSQL family", async () => {
  const { context } = await store("sqlite");
  await expect(
    assertUpdateDatabaseEngineContexts(
      [context, withDatabase(context, { families: { state: { engine: "postgres" } } })],
      ["postgres"],
      ["workboard"],
    ),
  ).rejects.toThrow(/target does not declare support for the PostgreSQL state family/);
});

it("protects selected PostgreSQL families before any anchor has been created", async () => {
  const { context } = await store("sqlite");
  const postgres = withDatabase(context, { engine: "postgres" });
  await expect(assertUpdateDatabaseEngineContexts([postgres], ["sqlite"])).rejects.toThrow(
    /target does not support the configured PostgreSQL families.*Reverse-port to SQLite/,
  );
  await expect(
    assertUpdateDatabaseEngineContexts([postgres], engines, families),
  ).resolves.toBeUndefined();
});

it("leaves a SQLite install unchanged when the target omits its optional declaration", async () => {
  const { file, context } = await store("sqlite");
  await unchanged(file, () => assertUpdateDatabaseEngineContexts([context], undefined));
});

it("protects a retained PostgreSQL anchor when Workboard is disabled", async () => {
  const { file, context } = await store("postgres", false);
  await unchanged(file, () =>
    expect(assertUpdateDatabaseEngineContexts([context], undefined)).rejects.toThrow(
      /target does not support the PostgreSQL store/,
    ),
  );
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "admits known stores without traversing another user's private historical backup",
  async () => {
    const { file, context } = await store("postgres", false);
    const historical = path.join(context.env.OPENCLAW_STATE_DIR, "backups", "old-repair");
    const marker = path.join(historical, ".openclaw-private-update-capture");
    await fs.mkdir(historical, { recursive: true });
    await fs.writeFile(marker, "openclaw-private-update-capture-v1\n");
    await fs.chmod(historical, 0o000);
    try {
      await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "EACCES" });
      await expect(
        assertUpdateDatabaseEngineContexts([context], engines, ["workboard"]),
      ).resolves.toBeUndefined();
      await expect(assertUpdateDatabaseEngineContexts([context], ["sqlite"])).rejects.toThrow(
        `target does not support the PostgreSQL store at ${file}`,
      );
    } finally {
      await fs.chmod(historical, 0o700);
    }
  },
);
