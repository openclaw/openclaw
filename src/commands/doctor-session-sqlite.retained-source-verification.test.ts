import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import {
  readDeferredPluginSessionImport,
  resolveVerifiedSessionSource,
  type SessionSourceVerification,
} from "../infra/deferred-plugin-session-sources.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as migrationArtifact from "./doctor-session-sqlite-artifact.js";
import * as migrationRun from "./doctor-session-sqlite-migration-run.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

afterEach(() => vi.restoreAllMocks());

describe("retained session source verification", () => {
  it.each([2, 32])(
    "reads each archive manifest once per verification of %s retained transcripts",
    async (transcriptCount) => {
      await withOpenClawTestState({ label: "deferred-plugin-manifest-reads" }, async (state) => {
        const { cfg, storePath, scope } = seedDeferredPluginSessionSource(state);
        const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
        for (let index = 2; index < transcriptCount; index++) {
          const sessionId = `legacy-volume-${index}`;
          const sessionFile = `${sessionId}.jsonl`;
          entries[`agent:main:volume-${index}`] = { sessionId, sessionFile, updatedAt: 20 };
          fs.writeFileSync(
            path.join(path.dirname(storePath), sessionFile),
            `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`,
          );
        }
        fs.writeFileSync(storePath, JSON.stringify(entries));
        const run = () =>
          runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        expect((await run()).totals.importedEntries).toBe(transcriptCount);
        recordDeferredPluginMigrations({
          env: state.env,
          pending: [],
          resolvedPluginIds: ["fixture-plugin"],
        });
        const archived = await run();
        expect(archived.totals.importedEntries).toBe(0);
        expect(archived.totals.archivedTranscriptFiles).toBe(transcriptCount);
        expect(fs.existsSync(storePath)).toBe(false);
        const manifestPaths = migrationRun.listSessionSqliteMigrationManifestPaths(state.env);
        const manifestPath = archived.migrationRun!.manifestPath;
        const manifestBytes = fs.readFileSync(manifestPath);
        const manifest = migrationRun.readSessionSqliteMigrationManifest(manifestPath)!;
        const transcriptMove = manifest.targets
          .flatMap((target) => target.plannedMoves)
          .find((move) => move.kind === "transcript")!;
        const read = () =>
          readDeferredPluginSessionImport({
            cfg,
            env: state.env,
            target: { agentId: "main", storePath },
            sqlitePath: resolveSqliteTargetFromSessionStorePath(storePath, scope).path,
          });
        const reads = vi.spyOn(fs, "readFileSync");
        for (let pass = 0; pass < 2; pass++) {
          reads.mockClear();
          expect(read()?.sources).toHaveLength(transcriptCount + 1);
          const manifestsRead = reads.mock.calls.flatMap(([file]) =>
            typeof file === "string" && manifestPaths.includes(file) ? [file] : [],
          );
          expect(manifestsRead.length).toBeGreaterThan(0);
          expect(manifestsRead.length).toBe(new Set(manifestsRead).size);
        }

        // A retained index can coexist with archived transcripts after interrupted archival.
        const moves = manifest.targets.flatMap((target) => target.plannedMoves);
        const indexMove = moves.find((move) => move.sourcePath === storePath)!;
        const transcriptArchives = moves
          .filter((move) => move.kind === "transcript")
          .map((move) => move.archivePath);
        fs.renameSync(indexMove.archivePath, storePath);
        const hashes = vi.spyOn(migrationArtifact, "readMigrationArtifactIdentity");
        for (let pass = 0; pass < 2; pass++) {
          reads.mockClear();
          hashes.mockClear();
          const validated = await runDoctorSessionSqlite({
            cfg,
            env: state.env,
            store: storePath,
            mode: "validate",
          });
          expect(validated.totals.importedEntries).toBe(0);
          expect(validated.totals.validatedEntries).toBe(transcriptCount);
          const verifiedArchives = hashes.mock.calls
            .map(([file]) => file)
            .filter((file) => transcriptArchives.includes(file));
          expect(verifiedArchives.toSorted()).toEqual(transcriptArchives.toSorted());
          const manifestsRead = reads.mock.calls.flatMap(([file]) =>
            typeof file === "string" && manifestPaths.includes(file) ? [file] : [],
          );
          expect(manifestsRead.length).toBeGreaterThan(0);
          // History discovery and receipt verification each read one copy per run.
          for (const file of manifestPaths) {
            expect(manifestsRead.filter((readPath) => readPath === file)).toHaveLength(2);
          }
        }
        hashes.mockRestore();
        fs.renameSync(storePath, indexMove.archivePath);
        reads.mockRestore();

        const source = {
          path: transcriptMove.sourcePath,
          identity: { ...transcriptMove.artifact!.identity },
        };
        const sourceTarget = {
          agentId: "main",
          storePath,
          sqlitePath: resolveSqliteTargetFromSessionStorePath(storePath, scope).path,
        };
        const verification: SessionSourceVerification = new Map();
        expect(resolveVerifiedSessionSource(source, sourceTarget, state.env, verification)).toBe(
          transcriptMove.archivePath,
        );
        source.identity.sha256 = "0".repeat(64);
        expect(
          resolveVerifiedSessionSource(source, sourceTarget, state.env, verification),
        ).toBeUndefined();
        source.identity = { ...transcriptMove.artifact!.identity };
        expect(
          resolveVerifiedSessionSource(
            source,
            { ...sourceTarget, agentId: "other" },
            state.env,
            verification,
          ),
        ).toBeUndefined();
        expect(
          resolveVerifiedSessionSource(
            source,
            sourceTarget,
            { ...state.env, OPENCLAW_STATE_DIR: state.statePath("other-state") },
            verification,
          ),
        ).toBeUndefined();

        for (const target of manifest.targets) {
          target.plannedMoves = target.plannedMoves.filter(
            (move) => move.sourcePath !== transcriptMove.sourcePath,
          );
          target.completedMoves = target.completedMoves.filter(
            (move) => move.sourcePath !== transcriptMove.sourcePath,
          );
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        expect(read).toThrow("Retained session migration source changed");
        fs.writeFileSync(manifestPath, manifestBytes);
        expect(read()?.sources).toHaveLength(transcriptCount + 1);
        fs.appendFileSync(transcriptMove.archivePath, "\n");
        expect(read).toThrow("Retained session migration source changed");
      });
    },
  );
});
