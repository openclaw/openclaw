import type { Pool, PoolClient } from "pg";

type Migration = {
  id: string;
  up: (client: PoolClient) => Promise<void>;
};

const MIGRATIONS_TABLE = "openclaw_state_migrations";

const migrations: Migration[] = [
  {
    id: "2026-02-26-0001-init",
    up: async (client) => {
      await client.query(`
        create table if not exists ${MIGRATIONS_TABLE} (
          id text primary key,
          applied_at timestamptz not null default now()
        )
      `);

      await client.query(`
        create table if not exists openclaw_auth_profile_store (
          scope text not null,
          data jsonb not null,
          updated_at timestamptz not null default now(),
          primary key (scope)
        )
      `);
    },
  },
  {
    id: "2026-02-27-0001-kv-store",
    up: async (client) => {
      await client.query(`
        create table if not exists openclaw_kv (
          key text primary key,
          data jsonb not null,
          updated_at timestamptz not null default now()
        )
      `);
    },
  },
];

let migrationsApplied = false;

export async function applyStateDbMigrations(pool: Pool): Promise<void> {
  if (migrationsApplied) {
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("begin");

    await client.query(`
      create table if not exists ${MIGRATIONS_TABLE} (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const existing = await client.query<{ id: string }>(
      `select id from ${MIGRATIONS_TABLE} order by applied_at asc`,
    );
    const applied = new Set(existing.rows.map((row: { id: string }) => row.id));

    for (const migration of migrations) {
      if (applied.has(migration.id)) {
        continue;
      }
      await migration.up(client);
      await client.query(`insert into ${MIGRATIONS_TABLE} (id) values ($1)`, [migration.id]);
    }

    await client.query("commit");
    migrationsApplied = true;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}
