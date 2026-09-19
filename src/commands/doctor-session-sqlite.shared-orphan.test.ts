import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { readDeferredPluginSessionImport } from "../infra/deferred-plugin-session-sources.js";
import * as directoryDurability from "../infra/directory-durability.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
} from "./doctor-session-sqlite-migration-run.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import {
  runDoctorSessionSqlite,
  settleRetainedDoctorSessionSources,
} from "./doctor-session-sqlite.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "settles every receipt sharing one orphan archive (interrupted index publication: %s)",
  async (interrupt) => {
    await withOpenClawTestState({ label: "shared-orphan-settlement" }, async (state) => {
      const { cfg, storePath } = seedDeferredPluginSessionSource(state, "legacy-root");
      cfg.agents = { ...cfg.agents, entries: { ...cfg.agents?.entries, ops: {} } };
      const entries: Record<string, unknown> = JSON.parse(fs.readFileSync(storePath, "utf8"));
      entries["agent:ops:kept"] = {
        sessionId: "ops-kept",
        sessionFile: "ops-kept.jsonl",
        updatedAt: 20,
      };
      fs.writeFileSync(storePath, JSON.stringify(entries));
      fs.writeFileSync(
        path.join(path.dirname(storePath), "ops-kept.jsonl"),
        JSON.stringify({ type: "session", version: 3, id: "ops-kept" }) + "\n",
      );
      const orphan = path.join(path.dirname(storePath), "deleted-orphan.jsonl");
      const bytes = Buffer.from('{"artifact":"shared recovery original"}\n');
      fs.writeFileSync(orphan, bytes);
      const run = () =>
        runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });

      await withDoctorSqliteMaintenanceLock({
        env: state.env,
        operation: "shared orphan migration",
        protectedPaths: [storePath],
        run: async (authority) => {
          let report = await run();
          expect(report.targets.map((target) => target.agentId).toSorted()).toEqual([
            "main",
            "ops",
          ]);
          const receipts = report.targets.map((target) => ({
            target,
            receipt: readDeferredPluginSessionImport({
              cfg,
              env: state.env,
              target,
              sqlitePath: target.sqlitePath,
            }),
          }));
          for (const { receipt } of receipts) {
            expect(receipt?.sources).toContainEqual(expect.objectContaining({ path: orphan }));
          }
          const settle = () =>
            settleRetainedDoctorSessionSources(report, ["fixture-plugin"], authority, () =>
              authority.assertCurrent(),
            );
          const archiveReport = report;
          if (interrupt) {
            const publish = directoryDurability.publishFileExclusive;
            const publication = vi
              .spyOn(directoryDurability, "publishFileExclusive")
              .mockImplementation(async (options) => {
                if (options.sourcePath === storePath) {
                  throw new Error("fixture index publication interrupted");
                }
                return publish(options);
              });
            await expect(settle()).rejects.toThrow("fixture index publication interrupted");
            publication.mockRestore();
            expect(fs.existsSync(storePath)).toBe(true);
            report = await run();
            expect(report.totals.importedEntries).toBe(0);
          }
          await expect(settle()).resolves.toBeUndefined();
          expect(report.targets.flatMap((target) => target.issues)).toEqual([]);
          expect(fs.existsSync(storePath)).toBe(false);
          expect(fs.existsSync(orphan)).toBe(false);

          const targets = listSessionSqliteMigrationManifestPaths(state.env).flatMap(
            (file) => readSessionSqliteMigrationManifest(file)?.targets ?? [],
          );
          const moves = receipts.map(({ target, receipt }) => {
            expect(
              readDeferredPluginSessionImport({
                cfg,
                env: state.env,
                target,
                sqlitePath: target.sqlitePath,
              }),
            ).toEqual(receipt);
            const archived = targets
              .filter((entry) => entry.agentId === target.agentId && entry.storePath === storePath)
              .flatMap((entry) => entry.completedMoves)
              .filter((move) => move.sourcePath === orphan);
            expect(archived).toHaveLength(1);
            return expectDefined(archived[0], `${target.agentId} orphan archive`);
          });
          const archivePath = expectDefined(moves[0], "shared orphan archive").archivePath;
          expect(moves.map((move) => move.archivePath)).toEqual([archivePath, archivePath]);
          expect(fs.readFileSync(archivePath)).toEqual(bytes);
          expect(fs.statSync(archivePath).nlink).toBe(1);
          for (const target of archiveReport.targets) {
            expect(target.archivedUnreferencedJsonlFiles).toEqual([archivePath]);
          }
          expect(archiveReport.totals.archivedUnreferencedJsonlFiles).toBe(1);
          for (const target of report.targets) {
            expect(target.archivedLegacyStoreFiles).toHaveLength(1);
          }
          expect(report.totals.archivedLegacyStoreFiles).toBe(1);
          recordDeferredPluginMigrations({
            env: state.env,
            pending: [],
            resolvedPluginIds: ["fixture-plugin"],
          });
          expect(readDeferredPluginMigrations({ env: state.env })).toEqual([]);
          const repeated = await run();
          expect(repeated.targets.flatMap((target) => target.issues)).toEqual([]);
          expect(repeated.totals.importedEntries).toBe(0);
          expect(repeated.totals.archivedUnreferencedJsonlFiles).toBe(0);
        },
      });
    });
  },
);
