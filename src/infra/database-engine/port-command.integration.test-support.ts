import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { expect, vi } from "vitest";
import { readBackupEngine } from "../../snapshot/database-backup.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as recovery from "../database-port-recovery.js";
import { listDirectoryTreeStrict } from "../directory-walk.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };
import { workboardPortProvider } from "./workboard-port.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
export const connection = typeof configured === "string" ? configured : undefined;
export const payload = ' {"first":1,"first":2,"escaped":"\\u0000"} \n';
const credentialRef = { source: "env", provider: "default", id: "OPENCLAW_P36_TEST_TOKEN" };
export const injected = "postgres://private-user:private-secret@example.invalid/payload";
export const portConfig = {
  plugins: { $include: "plugins.json" },
  gateway: { auth: { mode: "token" as const, token: credentialRef } },
  database: {
    engine: "sqlite" as const,
    postgres: { connection: "${OPENCLAW_P36_TEST_DATABASE_URL}" },
  },
};

function selectTable(table: (typeof metadata.tables)[number], namespace?: string) {
  const quote = (name: string) => `"${name}"`;
  const from = namespace ? `${quote(namespace)}.${quote(table.name)}` : quote(table.name);
  return `SELECT ${table.columns.map(({ name }) => quote(name)).join(",")} FROM ${from} ORDER BY ${table.pk.map(quote).join(",")}`;
}
export function seedPortSqlite(file: string, sql: string) {
  using db = openNodeSqliteDatabase(file);
  db.exec(sql);
}

function canonicalCells(
  rows: Record<string, unknown>[],
  columns: { name: string; type: string }[],
  postgres = false,
) {
  return rows.map((row) =>
    columns.map(({ name, type }) => {
      const cell = row[name];
      const value = postgres && type === "bigint" && typeof cell === "string" ? BigInt(cell) : cell;
      return value instanceof Uint8Array
        ? ["blob", Buffer.from(value).toString("hex")]
        : [typeof value, value];
    }),
  );
}
export function canonical(file: string) {
  using db = openNodeSqliteDatabase(file, { readOnly: true, readBigInts: true });
  return metadata.tables.map((table) => {
    const rows = db.prepare(selectTable(table)).all();
    return [table.name, canonicalCells(rows, table.columns)];
  });
}
export async function canonicalPostgres(client: Client, namespace: string) {
  const cells = [];
  for (const table of metadata.tables) {
    const { rows } = await client.query(selectTable(table, namespace));
    cells.push([table.name, canonicalCells(rows, table.columns, true)]);
  }
  return cells;
}

export function manifest(state: OpenClawTestState) {
  return readPortManifest(recovery.databasePortManifestPath(state.stateDir));
}
function readPortManifest(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8")) as recovery.DatabasePortManifest;
}
export async function dropPortSchemas(client: Client, manifests: string[], extra: string[] = []) {
  const targets = manifests.flatMap((file) => readPortManifest(file).targets ?? []);
  const locations = targets.flatMap(({ original, intended }) => [original, intended]);
  const namespaces = new Set([
    ...extra,
    ...locations.flatMap((location) =>
      location.engine === "postgres" ? [location.namespace] : [],
    ),
  ]);
  for (const namespace of namespaces) {
    assert.match(namespace, /^(?:(port|restore)_[a-f0-9]+|[a-z_][a-z0-9_]*_[a-f0-9]{16})$/);
    await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  }
}
export async function files(directory: string): Promise<string[]> {
  return (await listDirectoryTreeStrict(directory))
    .map((walkEntry) => walkEntry.dirent)
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .toSorted();
}
export async function fixture(
  run: (input: { state: OpenClawTestState; source: string; client?: Client }) => Promise<void>,
  postgres = false,
  rows = 1,
) {
  await withOpenClawTestState(
    {
      scenario: "minimal",
      prefix: "port-command-",
      env: {
        OPENCLAW_P36_TEST_DATABASE_URL: connection ?? injected,
        OPENCLAW_P36_TEST_TOKEN: "synthetic-port-secret",
      },
    },
    async (state) => {
      const source = state.statePath("plugins", "workboard", "workboard.sqlite");
      await state.writeText("plugins.json", '{"entries":{"workboard":{"enabled":false}}}');
      await state.writeConfig(portConfig);
      const { admit } = await workboardPortProvider.loadDescriptor();
      assert(admit);
      await admit(source);
      {
        using db = openNodeSqliteDatabase(source);
        db.exec(`UPDATE workboard_schema_migrations SET applied_at = 17;
          INSERT INTO workboard_boards (id, name, created_at, updated_at)
            VALUES ('board-é-🦞', '', -9223372036854775808, 9223372036854775807)`);
        const insert = db.prepare(
          "INSERT INTO workboard_cards (id, board_id, title, notes, status, priority, position, created_at, updated_at, automation_json) VALUES (?, 'board-é-🦞', ?, ?, 'todo', 'normal', ?, 9007199254740993, 1, ?)",
        );
        db.exec("BEGIN");
        for (let index = 0; index < rows; index++) {
          insert.run(
            `card-${String(index).padStart(4, "0")}`,
            `Card ${index}`,
            index ? "x".repeat(4500) : null,
            index / 8,
            payload,
          );
        }
        db.exec("COMMIT");
        db.exec(`INSERT INTO workboard_attachment_blobs VALUES ('blob', x'00ff8001');
          INSERT INTO workboard_card_notifications (id, card_id, ordinal, kind, message, created_at, sequence)
            VALUES ('notification', 'card-0000', 1, 'status', 'line one\nline two', 3, 9007199254740995);
          INSERT INTO workboard_notification_subscriptions (id, board_id, last_event_sequence, created_at, updated_at)
            VALUES ('subscription', 'board-é-🦞', 9007199254740995, 0, 1)`);
      }
      const client = postgres ? new Client({ connectionString: connection }) : undefined;
      await client?.connect();
      try {
        await run({ state, source, client });
      } finally {
        vi.restoreAllMocks();
        if (client) {
          const directory = state.statePath("recovery", "database-port");
          if (fs.existsSync(directory)) {
            const current = readBackupEngine(source);
            const manifests = (await files(directory)).filter(
              (file) => path.basename(file) === "manifest.json",
            );
            await dropPortSchemas(
              client,
              manifests,
              current.engine === "postgres" ? [current.namespace] : [],
            );
          }
          await client.end();
        }
      }
    },
  );
}

export function expectSafe(error: unknown, source: string, phase: string) {
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain(phase);
  expect(String(error)).toContain(source);
  expect(String(error)).toContain("required");
  expect(String(error)).not.toContain(injected);
  expect(String(error)).not.toContain("private-secret");
  expect(String(error)).not.toContain(payload);
}
