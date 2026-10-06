import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import { resolveSessionSqliteMigrationRunsDir } from "../infra/session-sqlite-migration-manifest.js";
import {
  importLegacyStore,
  readMigrationManifest,
  RECOVERY_TRANSCRIPT_LINES,
  trustedMigrationTarget,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

describe("pre-artifact session migration receipts", () => {
  it.each([
    { archive: "different", existing: false },
    { archive: "different", existing: true },
    { archive: "identical", existing: true },
    { archive: "missing", existing: true },
  ])(
    "imports a V2 index with $archive archive (existing: $existing)",
    async ({ archive, existing }) => {
      const store = createLegacyStore({
        transcriptLines: RECOVERY_TRANSCRIPT_LINES,
        entryOverrides: { label: "Legacy metadata" },
      });
      const scope = {
        agentId: "main",
        env: store.env,
        storePath: store.storePath,
        sessionKey: "agent:main:main",
      };
      if (existing) {
        await upsertSessionEntryCore(scope, {
          sessionId: "session-1",
          updatedAt: 3000,
          label: "Current SQLite metadata",
        });
      }
      const currentIndex = fs.readFileSync(store.storePath, "utf8");
      const archivePath = path.join(
        path.dirname(store.sessionDir),
        "session-sqlite-import-archive",
        "sessions.json.legacy.1785542400000",
      );
      const archivedIndex =
        archive === "identical"
          ? currentIndex
          : JSON.stringify({
              "agent:main:old": { sessionId: "older-session", updatedAt: 1 },
            });
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      if (archive !== "missing") {
        fs.writeFileSync(archivePath, archivedIndex);
      }
      const move = { archivePath, sourcePath: store.storePath, kind: "legacy-store" };
      // v2026.8.1-beta.1 doctor-session-sqlite-migration-run.ts wrote this V2 shape.
      const receipt = {
        manifestVersion: 2,
        openClawVersion: "2026.8.1-beta.1",
        runId: "session-sqlite-1785542400000-pre-artifact",
        startedAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-01T00:00:01.000Z",
        targets: [
          {
            ...trustedMigrationTarget(store),
            plannedMoves: [move],
            completedMoves: [move],
            validationBeforeArchive: "passed",
            issues: [],
          },
        ],
      };
      const manifestPath = path.join(
        resolveSessionSqliteMigrationRunsDir(store.env),
        `${receipt.runId}.json`,
      );
      fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
      const receiptBytes = JSON.stringify(receipt);
      fs.writeFileSync(manifestPath, receiptBytes);

      const imported = await importLegacyStore(store);

      expect(imported.targets.flatMap((target) => target.issues)).toEqual([]);
      expect(readMigrationManifest(imported.migrationRun?.manifestPath).completedAt).toBeDefined();
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: "session-1",
        label: existing && archive !== "different" ? "Current SQLite metadata" : "Legacy metadata",
      });
      const currentArchive = expectDefined(
        imported.targets[0]?.archivedLegacyStoreFiles?.[0],
        "verified current index archive",
      );
      expect(currentArchive).not.toBe(archivePath);
      expect(fs.readFileSync(currentArchive, "utf8")).toBe(currentIndex);
      if (archive !== "missing") {
        expect(fs.readFileSync(archivePath, "utf8")).toBe(archivedIndex);
      } else {
        expect(fs.existsSync(archivePath)).toBe(false);
      }
      expect(fs.readFileSync(manifestPath, "utf8")).toBe(receiptBytes);
      expect(() => assertSessionStoreMigrationComplete({ cfg: {}, env: store.env })).not.toThrow();
    },
  );
});
