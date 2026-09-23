import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import * as tar from "tar";
import { describe, expect, it } from "vitest";
import { CONFIG_AUDIT_MAX_ENTRIES, CONFIG_AUDIT_SCOPE } from "../config/io.audit.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntries, listArchiveEntryDetails } from "./backup-create.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";
import { detectLegacyAuditLogs, migrateLegacyAuditLogs } from "./state-migrations.audit-logs.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import { throwIfDoctorStateMigrationRefused } from "./state-migrations.messages.js";

describe("legacy audit portable backups", () => {
  it("replaces legacy audit raw archives with sanitized restorable snapshots", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-audit-raw-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const rawRelativePath = "logs/config-audit.jsonl.migrated.raw";
        const marker = "audit-value-7f3c";
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        await state.writeText(
          rawRelativePath,
          `${JSON.stringify({
            ts: "2026-07-01T00:00:00.000Z",
            source: "config-io",
            event: "config.write",
            argv: ["openclaw", "config", "set", "token", marker],
            execArgv: [],
          })}\n`,
        );
        const { db } = openOpenClawStateDatabase({ env: state.env });
        db.prepare(
          `
            INSERT INTO diagnostic_events (
              scope, event_key, payload_json, created_at, sequence
            ) VALUES ('migration.legacy-audit-raw', 'checkpoint', '{}', 1, 1)
          `,
        ).run();

        try {
          const result = await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: Date.UTC(2026, 4, 9, 8, 15, 0),
          });
          const entries = await listArchiveEntries(result.archivePath);
          const rawEntry = expectDefined(
            entries.find((entry) => entry.endsWith(`/state/${rawRelativePath}`)),
            "sanitized raw archive entry",
          );
          const databaseEntry = expectDefined(
            entries.find((entry) => entry.endsWith("/state/state/openclaw.sqlite")),
            "global state database entry",
          );
          expect(entries.some((entry) => entry.endsWith(".doctor-scrub-restore"))).toBe(false);

          await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
          const archivedRaw = await fs.readFile(path.join(extractDir, rawEntry), "utf8");
          expect(archivedRaw).not.toContain(marker);
          expect(JSON.parse(archivedRaw.trim())).toMatchObject({
            argv: ["openclaw", "config", "set", "token", "***"],
          });
          const sqlite = requireNodeSqlite();
          const archivedDb = new sqlite.DatabaseSync(path.join(extractDir, databaseEntry), {
            readOnly: true,
          });
          try {
            expect(
              archivedDb
                .prepare(
                  "SELECT COUNT(*) AS count FROM diagnostic_events WHERE scope = 'migration.legacy-audit-raw'",
                )
                .get(),
            ).toEqual({ count: 0 });
          } finally {
            archivedDb.close();
          }
        } finally {
          closeOpenClawStateDatabase();
        }
      },
    );
  });

  it.each(["completed", "quarantined"])(
    "omits %s audit append pads from portable backups",
    async (shape) => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-backup-completed-audit-pad-",
          scenario: "minimal",
        },
        async (state) => {
          const outputDir = state.path("backups");
          const extractDir = state.path("extract");
          const sourcePath = state.statePath("logs/config-audit.jsonl");
          const rawRelativePath = "logs/config-audit.jsonl.migrated.raw";
          const marker = "quarantined-audit-value-7f3c";
          await fs.mkdir(outputDir, { recursive: true });
          await fs.mkdir(extractDir, { recursive: true });
          await fs.mkdir(path.dirname(sourcePath), { recursive: true });
          await fs.writeFile(
            sourcePath,
            `${JSON.stringify({
              ts: "2026-07-01T00:00:00.000Z",
              source: "config-io",
              event: "config.write",
              argv: ["openclaw", "config", "set", "safe", "value"],
              execArgv: [],
            })}\n`,
          );
          await migrateLegacyAuditLogs({
            detected: detectLegacyAuditLogs({
              stateDir: state.stateDir,
              doctorOnlyStateMigrations: true,
            }),
            stateDir: state.stateDir,
          });
          expect(
            detectLegacyAuditLogs({
              stateDir: state.stateDir,
              doctorOnlyStateMigrations: true,
            }).hasLegacy,
          ).toBe(false);
          const sanitizedPath = `${sourcePath}.migrated`;
          const sanitizedBytes = await fs.readFile(sanitizedPath);
          let retainedPath = state.statePath(rawRelativePath);
          if (shape === "quarantined") {
            await fs.writeFile(
              retainedPath,
              `${JSON.stringify({
                ts: "2026-07-01T00:00:00.000Z",
                source: "config-io",
                event: "config.write",
                argv: ["openclaw", "config", "set", "token", marker],
                execArgv: [],
              })}\n`,
            );
            const cfg = { plugins: { enabled: false } };
            await state.writeConfig(cfg);
            const doctor = await autoMigrateLegacyState({
              cfg,
              env: state.env,
              homedir: () => state.home,
              doctorOnlyStateMigrations: true,
              legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
            });
            expect(() => throwIfDoctorStateMigrationRefused(doctor.stepReceipts)).not.toThrow();
            const quarantines = (await fs.readdir(path.dirname(retainedPath))).filter((name) =>
              name.startsWith("config-audit.jsonl.migrated.raw.quarantined-"),
            );
            expect(quarantines, doctor.warnings.join("\n")).toHaveLength(1);
            retainedPath = path.join(path.dirname(retainedPath), quarantines[0]!);
            expect(doctor.warnings).toContainEqual(expect.stringContaining(retainedPath));
          }
          const retainedBytes = await fs.readFile(retainedPath);
          if (shape === "quarantined") {
            expect(retainedBytes.toString()).toContain(marker);
          }
          const { db } = openOpenClawStateDatabase({ env: state.env });
          expect(
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM diagnostic_events WHERE scope = 'migration.legacy-audit-raw'",
              )
              .get(),
          ).toEqual({ count: 1 });

          try {
            const result = await createBackupArchive({
              output: outputDir,
              includeWorkspace: false,
              nowMs: Date.UTC(2026, 4, 9, 8, 20, 0),
            });
            const entries = await listArchiveEntries(result.archivePath);
            expect(entries.some((entry) => entry.endsWith(`/state/${rawRelativePath}`))).toBe(
              false,
            );
            expect(entries.some((entry) => entry.includes(".quarantined-"))).toBe(false);
            const sanitizedEntry = expectDefined(
              entries.find((entry) => entry.endsWith("/state/logs/config-audit.jsonl.migrated")),
              "sanitized audit history",
            );
            const databaseEntry = expectDefined(
              entries.find((entry) => entry.endsWith("/state/state/openclaw.sqlite")),
              "global state database entry",
            );
            await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
            await expect(fs.readFile(path.join(extractDir, sanitizedEntry))).resolves.toEqual(
              sanitizedBytes,
            );
            for (const entry of await listArchiveEntryDetails(result.archivePath)) {
              if (entry.type === "File") {
                const contents = await fs.readFile(path.join(extractDir, entry.path));
                expect(contents.includes(Buffer.from(marker)), entry.path).toBe(false);
              }
            }
            await expect(fs.readFile(retainedPath)).resolves.toEqual(retainedBytes);
            await expect(fs.readFile(sanitizedPath)).resolves.toEqual(sanitizedBytes);
            const sqlite = requireNodeSqlite();
            const archivedDb = new sqlite.DatabaseSync(path.join(extractDir, databaseEntry), {
              readOnly: true,
            });
            try {
              expect(
                archivedDb
                  .prepare(
                    "SELECT COUNT(*) AS count FROM diagnostic_events WHERE scope = 'migration.legacy-audit-raw'",
                  )
                  .get(),
              ).toEqual({ count: 0 });
            } finally {
              archivedDb.close();
            }
          } finally {
            closeOpenClawStateDatabase();
          }
        },
      );
    },
  );

  it("preserves audit ordinals for identical later appends across backup restore", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-audit-ordinal-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const extractDir = state.path("extract");
        const sourcePath = state.statePath("logs/config-audit.jsonl");
        const rawRelativePath = "logs/config-audit.jsonl.migrated.raw";
        const record = {
          ts: "2026-07-01T00:00:00.000Z",
          source: "config-io",
          event: "config.write",
          argv: ["openclaw", "config", "set", "safe", "same"],
          execArgv: [],
        };
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(extractDir, { recursive: true });
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(sourcePath, `${JSON.stringify(record)}\n`);
        await migrateLegacyAuditLogs({
          detected: detectLegacyAuditLogs({
            stateDir: state.stateDir,
            doctorOnlyStateMigrations: true,
          }),
          stateDir: state.stateDir,
        });
        await fs.appendFile(state.statePath(rawRelativePath), `${JSON.stringify(record)}\n`);

        const result = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 4, 9, 8, 25, 0),
        });
        const entries = await listArchiveEntries(result.archivePath);
        const databaseEntry = expectDefined(
          entries.find((entry) => entry.endsWith("/state/state/openclaw.sqlite")),
          "global state database entry",
        );
        await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
        closeOpenClawStateDatabase();

        const restoredDatabasePath = path.join(extractDir, databaseEntry);
        const restoredStateDir = path.dirname(path.dirname(restoredDatabasePath));
        try {
          const restoredDetection = detectLegacyAuditLogs({
            stateDir: restoredStateDir,
            doctorOnlyStateMigrations: true,
          });
          expect(restoredDetection.hasLegacy).toBe(true);
          await migrateLegacyAuditLogs({
            detected: restoredDetection,
            stateDir: restoredStateDir,
          });
          const restoredEntries = createSqliteAuditRecordStore({
            scope: CONFIG_AUDIT_SCOPE,
            maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
            env: { ...process.env, OPENCLAW_STATE_DIR: restoredStateDir },
          }).entries();
          expect(new Set(restoredEntries.map((entry) => entry.key)).size).toBe(2);
          expect(restoredEntries.map((entry) => entry.value)).toEqual([record, record]);
        } finally {
          closeOpenClawStateDatabaseByPath(restoredDatabasePath);
        }
      },
    );
  });
});
