import "../snapshot/database-backup.js";
import "./backup-sqlite-snapshot.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { assertUpdateDatabaseEngineContexts as admitEngines } from "./update-database-engine-admission.js";

vi.mock("../snapshot/database-backup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../snapshot/database-backup.js")>()),
  readPostgresBackupFamily: vi.fn(async () => "workboard"),
}));

const directories = useAutoCleanupTempDirTracker(afterEach);
const engines = ["sqlite", "postgres"];
const families = ["state", "agent", "workboard", "logbook", "team-reports"];
type Context = Parameters<typeof admitEngines>[0][number];

function withDatabase(context: Context, database: OpenClawConfig["database"]): Context {
  const postgres = { connection: "postgresql://synthetic.invalid/update-admission" };
  return { ...context, config: { ...context.config, database: { ...database, postgres } } };
}

async function store(engine: "sqlite" | "postgres", enabled = true) {
  const stateDir = directories.make("update-engine-admission-");
  const file = path.join(stateDir, "plugins", "workboard", "workboard.sqlite");
  await createStore(file, engine, "retained_workboard");
  return {
    file,
    context: {
      config: { plugins: { entries: { workboard: { enabled } } } },
      env: { OPENCLAW_STATE_DIR: stateDir },
    },
  };
}

async function createStore(file: string, engine: "sqlite" | "postgres", schema: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  using db = openNodeSqliteDatabase(file);
  if (engine === "postgres") {
    db.exec(`CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT);
      INSERT INTO openclaw_engine_anchor VALUES ('e3b4e990-c0f1-4ec7-a5d1-4e1c6824f80f','postgres','${schema}')`);
  } else {
    db.exec("CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('retained')");
  }
}

const reversePort = /Reverse-port to SQLite with the current binary/;
it.each([
  ["postgres", true, undefined, reversePort],
  ["postgres", true, ["sqlite"], reversePort],
  ["postgres", true, [], reversePort],
  ["postgres", true, "postgres", reversePort],
  ["postgres", true, engines, null],
  ["sqlite", true, undefined, null],
  ["postgres", false, undefined, /target does not support the PostgreSQL store/],
] as const)(
  "preserves the %s store (enabled=%s, target=%j)",
  async (engine, enabled, declaration, error) => {
    const { file, context } = await store(engine, enabled);
    const before = await fs.readFile(file);
    const activate = vi.fn();
    const admission = admitEngines([context], declaration, ["workboard"]).then(activate);
    if (error) {
      await expect(admission).rejects.toThrow(error);
    } else {
      await admission;
    }
    expect(activate).toHaveBeenCalledTimes(error ? 0 : 1);
    expect(await fs.readFile(file)).toEqual(before);
    expect(await fs.readdir(path.dirname(file))).toEqual(["workboard.sqlite"]);
  },
);

it.each(["sqlite", "postgres"] as const)(
  "reads a legacy registry before deciding whether its retained %s agent prevents downgrade",
  async (engine) => {
    const { context } = await store("sqlite");
    const registry = path.join(context.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
    const retained = path.join(directories.make("retained-agent-engine-"), "agent.sqlite");
    await fs.mkdir(path.dirname(registry), { recursive: true });
    await createStore(retained, engine, "retained_agent");
    {
      using shared = openNodeSqliteDatabase(registry);
      shared.exec("PRAGMA user_version=17; CREATE TABLE agent_databases(path TEXT)");
      shared.prepare("INSERT INTO agent_databases VALUES (?)").run(retained);
    }
    const before = await Promise.all([fs.readFile(registry), fs.readFile(retained)]);
    const inspection = admitEngines([context], undefined);
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
    const before = await fs.readFile(file);
    await admitEngines([withDatabase(context, database)], engines, families);
    expect(await fs.readFile(file)).toEqual(before);
  },
);

it("checks every context for its selected PostgreSQL family", async () => {
  const { context } = await store("sqlite");
  await expect(
    admitEngines(
      [context, withDatabase(context, { families: { state: { engine: "postgres" } } })],
      ["postgres"],
      ["workboard"],
    ),
  ).rejects.toThrow(/target does not declare support for the PostgreSQL state family/);
});

it("protects selected PostgreSQL families before any anchor has been created", async () => {
  const { context } = await store("sqlite");
  const postgres = withDatabase(context, { engine: "postgres" });
  await expect(admitEngines([postgres], ["sqlite"])).rejects.toThrow(
    /target does not support the configured PostgreSQL families.*Reverse-port to SQLite/,
  );
  await expect(admitEngines([postgres], engines, families)).resolves.toBeUndefined();
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
      await expect(admitEngines([context], engines, ["workboard"])).resolves.toBeUndefined();
      await expect(admitEngines([context], ["sqlite"])).rejects.toThrow(
        `target does not support the PostgreSQL store at ${file}`,
      );
    } finally {
      await fs.chmod(historical, 0o700);
    }
  },
);
