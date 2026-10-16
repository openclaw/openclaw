import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import type { WorkboardDatabasePortApi } from "@openclaw/workboard-contract";
import { Client } from "pg";
import { expect, vi } from "vitest";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import { readBackupEngine } from "../../snapshot/database-backup.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as recovery from "../database-port-recovery.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

const configured = getEnvironmentData("openclaw.test.workboard.connection");
export const connection = typeof configured === "string" ? configured : undefined;
export const payload = ' {"first":1,"first":2,"escaped":"\\u0000"} \n';
export const credentialRef = { source: "env", provider: "default", id: "OPENCLAW_P36_TEST_TOKEN" };
export const injected = "postgres://private-user:private-secret@example.invalid/payload";

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
    const rows = db
      .prepare(
        `SELECT ${table.columns.map(({ name }) => `"${name}"`).join(",")} FROM "${table.name}" ORDER BY ${table.pk.map((name) => `"${name}"`).join(",")}`,
      )
      .all();
    return [table.name, canonicalCells(rows, table.columns)];
  });
}
export async function canonicalPostgres(client: Client, namespace: string) {
  const cells = [];
  for (const table of metadata.tables) {
    const rows = (
      await client.query(
        `SELECT ${table.columns.map(({ name }) => `"${name}"`).join(",")} FROM "${namespace}"."${table.name}" ORDER BY ${table.pk.map((name) => `"${name}"`).join(",")}`,
      )
    ).rows;
    cells.push([table.name, canonicalCells(rows, table.columns, true)]);
  }
  return cells;
}

export function manifest(state: OpenClawTestState) {
  return JSON.parse(
    fs.readFileSync(recovery.databasePortManifestPath(state.stateDir), "utf8"),
  ) as recovery.DatabasePortManifest;
}
export async function files(directory: string): Promise<string[]> {
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? await files(file) : [file];
      }),
    )
  )
    .flat()
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
      await state.writeText(
        "plugins.json",
        JSON.stringify({ entries: { workboard: { enabled: false } } }),
      );
      await state.writeConfig({
        plugins: { $include: "plugins.json" },
        gateway: { auth: { mode: "token", token: credentialRef } },
        database: {
          engine: "sqlite",
          postgres: { connection: "${OPENCLAW_P36_TEST_DATABASE_URL}" },
        },
      });
      loadBundledPluginPublicArtifactModuleSync<{
        workboardDatabasePortApi: WorkboardDatabasePortApi<
          ReturnType<typeof openNodeSqliteDatabase>,
          never
        >;
      }>({
        dirName: "workboard",
        artifactBasename: "database-port-api.js",
      }).workboardDatabasePortApi.admitWorkboardPort(source);
      {
        using db = openNodeSqliteDatabase(source);
        db.exec("UPDATE workboard_schema_migrations SET applied_at = 17");
        db.prepare(
          "INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        ).run("board-é-🦞", "", -9223372036854775808n, 9223372036854775807n);
        const insert = db.prepare(
          "INSERT INTO workboard_cards (id, board_id, title, notes, status, priority, position, created_at, updated_at, automation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        db.exec("BEGIN");
        for (let index = 0; index < rows; index++) {
          insert.run(
            `card-${String(index).padStart(4, "0")}`,
            "board-é-🦞",
            `Card ${index}`,
            index ? "x".repeat(4500) : null,
            "todo",
            "normal",
            index / 8,
            9007199254740993n,
            1,
            payload,
          );
        }
        db.exec("COMMIT");
        db.prepare("INSERT INTO workboard_attachment_blobs VALUES (?, ?)").run(
          "blob",
          Buffer.from([0, 255, 128, 1]),
        );
        db.prepare(
          "INSERT INTO workboard_card_notifications (id, card_id, ordinal, kind, message, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run("notification", "card-0000", 1, "status", "line one\nline two", 3, 9007199254740995n);
        db.prepare(
          "INSERT INTO workboard_notification_subscriptions (id, board_id, last_event_sequence, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run("subscription", "board-é-🦞", 9007199254740995n, 0, 1);
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
            const owned = new Set<string>();
            for (const file of await files(directory)) {
              if (path.basename(file) !== "manifest.json") {
                continue;
              }
              const saved = JSON.parse(
                fs.readFileSync(file, "utf8"),
              ) as recovery.DatabasePortManifest;
              for (const target of saved.targets ?? []) {
                if (target.intended.engine === "postgres") {
                  owned.add(target.intended.namespace);
                }
                if (target.original.engine === "postgres") {
                  owned.add(target.original.namespace);
                }
              }
            }
            const current = readBackupEngine(source);
            if (current.engine === "postgres") {
              owned.add(current.namespace);
            }
            for (const namespace of owned) {
              assert.match(namespace, /^(port|restore)_[a-f0-9]+$/);
              await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
            }
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
