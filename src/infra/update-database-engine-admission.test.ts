import "../snapshot/database-backup.js";
import "./backup-sqlite-snapshot.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { assertUpdateDatabaseEngineContexts } from "./update-database-engine-admission.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

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
  const before = await fs.readFile(file);
  await assertUpdateDatabaseEngineContexts([context], ["sqlite", "postgres"]);
  expect(await fs.readFile(file)).toEqual(before);
});

it.each([
  { engine: "sqlite", families: { workboard: { engine: "postgres" } } },
  { engine: "postgres", families: { workboard: { engine: "sqlite" } } },
  { engine: "sqlite", families: { state: { engine: "postgres" } } },
] satisfies NonNullable<OpenClawConfig["database"]>[])(
  "refuses mixed-engine updates even when the candidate supports PostgreSQL (%j)",
  async (database) => {
    const { file, context } = await store("sqlite");
    const before = await fs.readFile(file);
    const activate = vi.fn();
    await expect(
      assertUpdateDatabaseEngineContexts(
        [{ ...context, config: { ...context.config, database } }],
        ["sqlite", "postgres"],
      ).then(activate),
    ).rejects.toThrow(/update for mixed-engine installs is not supported yet; use a single engine/);
    expect(activate).not.toHaveBeenCalled();
    expect(await fs.readFile(file)).toEqual(before);
  },
);

it("checks every context before accepting a PostgreSQL-capable candidate", async () => {
  const { context } = await store("sqlite");
  await expect(
    assertUpdateDatabaseEngineContexts(
      [
        context,
        { ...context, config: { database: { families: { state: { engine: "postgres" } } } } },
      ],
      ["postgres"],
    ),
  ).rejects.toThrow(/update for mixed-engine installs is not supported yet/);
});

it.each([
  { engine: "sqlite", families: {} },
  { engine: "sqlite", families: { agent: { engine: "sqlite" } } },
  {
    engine: "sqlite",
    families: {
      state: { engine: "postgres" },
      agent: { engine: "postgres" },
      workboard: { engine: "postgres" },
      logbook: { engine: "postgres" },
      "team-reports": { engine: "postgres" },
    },
  },
  {
    engine: "postgres",
    families: {
      state: { engine: "sqlite" },
      agent: { engine: "sqlite" },
      workboard: { engine: "sqlite" },
      logbook: { engine: "sqlite" },
      "team-reports": { engine: "sqlite" },
    },
  },
] satisfies NonNullable<OpenClawConfig["database"]>[])(
  "refuses family-config updates until targets understand the config shape (%j)",
  async (database) => {
    const { file, context } = await store("sqlite");
    const before = await fs.readFile(file);
    const activate = vi.fn();
    await expect(
      assertUpdateDatabaseEngineContexts(
        [{ ...context, config: { ...context.config, database } }],
        ["sqlite", "postgres"],
      ).then(activate),
    ).rejects.toThrow(/Update with database\.families overrides.*matching database\.engine/);
    expect(activate).not.toHaveBeenCalled();
    expect(await fs.readFile(file)).toEqual(before);
  },
);

it("protects selected PostgreSQL families before any anchor has been created", async () => {
  const { context } = await store("sqlite");
  const postgres = {
    ...context,
    config: {
      ...context.config,
      database: { engine: "postgres" },
    } satisfies OpenClawConfig,
  };
  await expect(assertUpdateDatabaseEngineContexts([postgres], ["sqlite"])).rejects.toThrow(
    /target does not support the configured PostgreSQL families.*Reverse-port to SQLite/,
  );
  await expect(
    assertUpdateDatabaseEngineContexts([postgres], ["sqlite", "postgres"]),
  ).resolves.toBeUndefined();
});

it("leaves a SQLite install unchanged when the target omits its optional declaration", async () => {
  const { file, context } = await store("sqlite");
  const before = await fs.readFile(file);
  await assertUpdateDatabaseEngineContexts([context], undefined);
  expect(await fs.readFile(file)).toEqual(before);
});

it("protects a retained PostgreSQL anchor when Workboard is disabled", async () => {
  const { file, context } = await store("postgres", false);
  const before = await fs.readFile(file);
  await expect(assertUpdateDatabaseEngineContexts([context], undefined)).rejects.toThrow(
    /target does not support the PostgreSQL store/,
  );
  expect(await fs.readFile(file)).toEqual(before);
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
        assertUpdateDatabaseEngineContexts([context], ["sqlite", "postgres"]),
      ).resolves.toBeUndefined();
      await expect(assertUpdateDatabaseEngineContexts([context], ["sqlite"])).rejects.toThrow(
        `target does not support the PostgreSQL store at ${file}`,
      );
    } finally {
      await fs.chmod(historical, 0o700);
    }
  },
);
