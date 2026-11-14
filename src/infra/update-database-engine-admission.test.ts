import fs from "node:fs/promises";
import "./backup-sqlite-snapshot.js";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readPostgresBackupFamily } from "../snapshot/database-backup.js";
import { DatabaseSearchCapabilityUnavailableError } from "./database-engine/capability-unavailable.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { assertUpdateDatabaseEngineContexts as admitEngines } from "./update-database-engine-admission.js";

vi.mock("../snapshot/database-backup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../snapshot/database-backup.js")>()),
  readPostgresBackupFamily: vi.fn(async () => "workboard"),
}));

const directories = useAutoCleanupTempDirTracker(afterEach);
const engines = ["sqlite", "postgres"];
const families = ["state", "agent", "workboard", "logbook", "team-reports"];
const workboardPostgres = { families: { workboard: { engine: "postgres" } } } as const;
const statePostgres = { families: { state: { engine: "postgres" } } } as const;
const capabilityError = new DatabaseSearchCapabilityUnavailableError(
  "fullText",
  'PostgreSQL unaccent capability unavailable. Have a database administrator run: CREATE EXTENSION IF NOT EXISTS "unaccent" WITH SCHEMA "public";',
);

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
  ["postgres", true, engines, null],
  ["sqlite", true, undefined, null],
  ["postgres", false, undefined, /target does not support the PostgreSQL store/],
  ["postgres", true, engines, capabilityError, workboardPostgres],
  ["sqlite", true, engines, null, { engine: "sqlite", ...workboardPostgres }],
  ["sqlite", true, ["sqlite"], /configured PostgreSQL families/, { engine: "postgres" }],
  ["sqlite", true, engines, null, { engine: "postgres" }],
  ["sqlite", true, engines, /PostgreSQL state family/, statePostgres],
] as const)(
  "preserves the %s store (enabled=%s, target=%j, error=%s, database=%j)",
  async (...[engine, enabled, declaration, error, database]) => {
    const { file, context } = await store(engine, enabled);
    const before = await fs.readFile(file);
    if (error instanceof Error) {
      vi.mocked(readPostgresBackupFamily).mockRejectedValueOnce(error);
    }
    const postgres = { connection: "postgresql://synthetic.invalid/update-admission" };
    const config = { ...context.config, database: { ...database, postgres } };
    const contexts = database ? [context, { ...context, config }] : [context];
    const admission = admitEngines(contexts, declaration, error ? ["workboard"] : families);
    if (error instanceof Error) {
      await expect(admission).rejects.toMatchObject({
        reason: "database-engine-preflight",
        cause: error,
        message: expect.stringContaining(error.message),
      });
      await expect(admission).rejects.not.toThrow(/Reverse-port|cannot be captured/);
    } else if (error) {
      await expect(admission).rejects.toThrow(error);
    } else {
      await admission;
    }
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
