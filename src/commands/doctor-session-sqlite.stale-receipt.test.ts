import fs from "node:fs";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import {
  databaseIdentity,
  readDeferredPluginSessionImportReceipt,
} from "../infra/deferred-plugin-session-source-read.js";
import { rebuildDeferredPluginSessionSourceIndex } from "../infra/deferred-plugin-session-source-recovery.js";
import * as sessionVerification from "../infra/deferred-plugin-session-verification.js";
import * as migrationArtifacts from "../infra/session-sqlite-migration-artifact.js";
import * as migrationRun from "../infra/session-sqlite-migration-manifest.js";
import { readOnlySqliteValidationSnapshot } from "../infra/session-sqlite-migration-readers.js";
import { migrateLegacyAcpSessionMetadata } from "../infra/state-migrations.session-store.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  seedDeferredPluginSessionSource,
  seedStaleDeferredPluginSessionImport,
  addDeferredPluginSessions,
} from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { expectIssue, migrationManifest } from "./doctor-session-sqlite.fixtures.test-support.js";
import { runDoctorSessionSqlite as doctor } from "./doctor-session-sqlite.js";
import { expectFiles } from "./doctor-session-sqlite.publication-spies.test-support.js";
import { expectNoIssue, stateRows, writeState } from "./doctor-session-sqlite.test-support.js";

async function staleFixture(state: OpenClawTestState) {
  const source = await seedStaleDeferredPluginSessionImport(state);
  const { cfg, scope, storePath } = source;
  return {
    ...source,
    source: path.join(path.dirname(storePath), "legacy-kept.jsonl"),
    run: (mode: "import" | "recover" = "import") =>
      doctor({ cfg, env: state.env, allAgents: true, mode }),
    entry: (sessionKey: string) => loadExactSessionEntry({ ...scope, sessionKey })?.entry,
    events: (sessionId = "legacy-kept") => loadTranscriptEventsSync({ ...scope, sessionId }),
    write: (sessionKey: string, entry: Parameters<typeof upsertSessionEntryCore>[1]) =>
      upsertSessionEntryCore({ ...scope, sessionKey }, entry),
    keep: (sessionId: string, label: string) =>
      upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:kept" },
        { sessionId, label, updatedAt: Date.now() },
      ),
    ready: () => assertSessionStoreMigrationComplete({ cfg, env: state.env }),
    rows: (sql: string) => stateRows(state.env, sql),
  };
}

function withStaleReceipt(
  run: (fixture: Awaited<ReturnType<typeof staleFixture>>) => Promise<void>,
) {
  return withOpenClawTestState({ label: "stale-receipt" }, async (state) =>
    run(await staleFixture(state)),
  );
}

it.each([2, 32].flatMap((count) => ["stale", "rebuild"].map((phase) => ({ count, phase }))))(
  "bounds manifest parses for $phase with $count archived transcripts",
  ({ count, phase }) =>
    withOpenClawTestState({ label: "receipt-manifest-parses" }, async (state) => {
      const { cfg, storePath } = await seedDeferredPluginSessionSource(state);
      addDeferredPluginSessions(storePath, count);
      const options = { cfg, env: state.env, allAgents: true };
      expect((await doctor({ ...options, mode: "import" })).totals.importedEntries).toBe(count);
      await recordDeferredPluginMigrations({
        env: state.env,
        pending: [],
        resolvedPluginIds: ["fixture-plugin"],
      });
      const archived = await doctor({ ...options, mode: "import" });
      expect(archived.totals.archivedTranscriptFiles).toBe(count);
      const moves = migrationManifest(archived).targets.flatMap((target) => target.plannedMoves);
      if (phase === "stale") {
        fs.renameSync(moves.find((move) => move.sourcePath === storePath)!.archivePath, storePath);
      } else {
        for (const move of moves.filter((candidate) => candidate.kind === "transcript")) {
          fs.writeFileSync(move.sourcePath, fs.readFileSync(move.archivePath, "utf8") + "\n");
        }
      }
      writeState(state.env, [
        `UPDATE migration_sources SET removed_source = 0${phase === "stale" ? ", report_json = json_set(report_json, '$.databaseIdentity', '123:456')" : ""} WHERE migration_kind = 'deferred-plugin-session-import'`,
      ]);
      const manifestCount = migrationRun.listSessionSqliteMigrationManifestPaths(state.env).length;
      const parses = vi.spyOn(migrationRun, "readSessionSqliteMigrationManifest");
      onTestFinished(() => parses.mockRestore());
      if (phase === "stale") {
        const report = await doctor({ ...options, mode: "validate" });
        expectIssue(report, { code: "retained_plugin_receipt_superseded" });
        expectNoIssue(report, "historical_transcript_deferred");
      } else {
        const target = archived.targets[0]!;
        const rebuilt = await rebuildDeferredPluginSessionSourceIndex({
          ...options,
          target,
          sqlitePath: target.sqlitePath,
        });
        expect(rebuilt).toBe(true);
      }
      expect(parses).toHaveBeenCalledTimes(manifestCount * (phase === "stale" ? 2 : 1));
    }),
);

it.each([
  { available: true, pending: true },
  { available: false, pending: true },
  { available: true, pending: false },
])(
  "settles a foreign receipt with history available=$available and plugin pending=$pending",
  ({ available, pending }) =>
    withStaleReceipt(async (f) => {
      const { storePath, foreignReport, source } = f;
      if (!pending) {
        await recordDeferredPluginMigrations({
          env: f.scope.env,
          pending: [],
          resolvedPluginIds: ["brave"],
        });
      }
      await f.write("agent:main:deleted", { label: "Live settings" });
      const original = fs.readFileSync(source);
      fs.unlinkSync(storePath);
      if (!available) {
        fs.unlinkSync(source);
      }

      const report = await f.run(available ? "recover" : "import");
      expectIssue(report, { code: "retained_plugin_receipt_superseded" });
      expectNoIssue(report, "retained_plugin_source_conflict");
      expect(f.entry("agent:main:deleted")?.label).toBe("Live settings");
      if (available) {
        expect(f.events()).toHaveLength(2);
        expect(f.entry("agent:main:recovered:legacy-kept")?.archivedAt).toBeTruthy();
        if (pending) {
          expectFiles(original, source);
        } else {
          expect(fs.existsSync(source)).toBe(false);
          expect(
            report.targets
              .flatMap((target) => target.archivedTranscriptFiles)
              .map((file) => fs.readFileSync(file)),
          ).toContainEqual(original);
        }
      } else {
        expect(f.events()).toEqual([]);
        expectIssue(report, {
          code: "historical_transcript_deferred",
          message: expect.stringContaining(source),
        });
      }
      const superseded = f.rows(
        "SELECT report_json FROM migration_runs WHERE status = 'superseded'",
      );
      expect(superseded).toHaveLength(1);
      expect(JSON.parse(String(superseded?.[0]?.report_json))).toMatchObject({
        receipt: JSON.parse(foreignReport),
        reason: expect.stringContaining("different database"),
      });
      expect(f.ready).not.toThrow();
      const repeated = await f.run();
      expect(repeated.totals.importedTranscriptEvents).toBe(0);
      if (available) {
        expectNoIssue(repeated, "retained_plugin_receipt_superseded");
      }
    }),
);

it("preserves live generations and archived deletions while recovering foreign history", async () => {
  await withStaleReceipt(async (f) => {
    const { scope, storePath } = f;
    await f.keep("current-kept", "Current generation");
    await expect(
      deleteSessionEntryLifecycle({
        ...scope,
        archiveTranscript: true,
        target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
      }),
    ).resolves.toMatchObject({ deleted: true });
    const archivedHistory = f.events("legacy-deleted");
    const report = await f.run();
    expect(f.entry("agent:main:kept")).toMatchObject({
      sessionId: "current-kept",
      label: "Current generation",
    });
    expect(f.events()).toHaveLength(2);
    expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" })).toBeUndefined();
    expect(f.events("legacy-deleted")).toEqual(archivedHistory);
    const snapshot = readOnlySqliteValidationSnapshot({ agentId: "main", storePath });
    if (!snapshot.ok) {
      throw snapshot.error;
    }
    expect(snapshot.snapshot.transcriptEventCountsBySessionId.has("legacy-deleted")).toBe(false);
    expectIssue(report, {
      code: "historical_transcript_deferred",
      message: expect.stringContaining("existing deletion and archive state remain authoritative"),
    });
    expect(fs.existsSync(storePath)).toBe(true);
    expect(f.ready).not.toThrow();
  });
});

it.each(["changed", "unreadable"] as const)(
  "recovers independently of a foreign receipt's %s source",
  (kind) =>
    withStaleReceipt(async (f) => {
      const { storePath, source } = f;
      fs.unlinkSync(storePath);
      if (kind === "changed") {
        fs.appendFileSync(source, "\n");
      }
      const readIdentity = migrationArtifacts.readMigrationArtifactIdentity;
      const unreadable =
        kind === "unreadable"
          ? vi
              .spyOn(migrationArtifacts, "readMigrationArtifactIdentity")
              .mockImplementation((file, ...args) => {
                if (file === source) {
                  throw new Error("fixture retained input unreadable");
                }
                return readIdentity(file, ...args);
              })
          : undefined;
      const first = await f.run().finally(() => unreadable?.mockRestore());
      if (kind === "unreadable") {
        expectIssue(first, {
          code: "historical_transcript_deferred",
          message: expect.stringContaining("fixture retained input unreadable"),
        });
        expect(f.events()).toEqual([]);
      } else {
        expect(f.events()).toHaveLength(2);
      }
      const recovered = await f.run();
      expect(recovered.totals.importedTranscriptEvents).toBe(kind === "unreadable" ? 2 : 0);
      expect(f.events()).toHaveLength(2);
      if (kind === "changed") {
        expectNoIssue(recovered, "retained_plugin_receipt_superseded");
      }
    }),
);

it("keeps canonical ACP metadata authoritative on the next Doctor pass", async () => {
  await withStaleReceipt(async (f) => {
    await f.keep("legacy-kept", "Canonical settings");
    const migrate = () =>
      migrateLegacyAcpSessionMetadata({
        cfg: f.cfg,
        env: f.scope.env,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
    expect((await migrate()).warnings).toEqual([]);
    await f.run();
    expect((await migrate()).warnings).toEqual([]);
    expect(f.entry("agent:main:kept")?.label).toBe("Canonical settings");
    expect(f.events()).toHaveLength(2);
    expect(f.rows("SELECT count(*) AS count FROM acp_sessions")?.[0]).toEqual({ count: 0 });
  });
});

it.each(["receipt", "physical", "foreign"] as const)(
  "only supersedes a foreign binding before verification (%s receipt)",
  async (binding) => {
    await withOpenClawTestState({ label: "receipt-verification-io" }, async (state) => {
      const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(state, "default");
      await doctor({ cfg, env: state.env, allAgents: true, mode: "import" });
      const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, scope).path;
      const params = { cfg, target: { agentId: "main", storePath }, sqlitePath, env: state.env };
      const original = readDeferredPluginSessionImportReceipt(params)!;
      const recorded = JSON.parse(original.reportJson);
      recorded.databaseIdentity =
        binding === "foreign" ? "123:456" : databaseIdentity(sqlitePath, binding);
      writeState(state.env, [
        "UPDATE migration_sources SET report_json = ? WHERE source_key = ?",
        JSON.stringify(recorded),
        original.sourceKey,
      ]);
      const before = readDeferredPluginSessionImportReceipt(params);
      const source = path.join(path.dirname(storePath), "legacy-kept.jsonl");
      fs.writeFileSync(source, "");
      const failure = new Error("EIO: fixture database verification read failed");
      const verify = vi
        .spyOn(sessionVerification, "verifyDeferredSessionDatabase")
        .mockRejectedValue(failure);
      try {
        if (binding === "foreign") {
          await expect(rebuildDeferredPluginSessionSourceIndex(params)).resolves.toBe(true);
          expect(verify).not.toHaveBeenCalled();
          expect(readDeferredPluginSessionImportReceipt(params)).toMatchObject({
            removedSource: false,
            reportJson: expect.stringContaining('"superseded":"different-database"'),
          });
        } else {
          await expect(rebuildDeferredPluginSessionSourceIndex(params)).rejects.toBe(failure);
          expect(verify).toHaveBeenCalledOnce();
          expect(readDeferredPluginSessionImportReceipt(params)).toEqual(before);
          expect(
            stateRows(
              state.env,
              "SELECT count(*) AS count FROM migration_runs WHERE status = 'superseded'",
            )?.[0],
          ).toEqual({ count: 0 });
        }
      } finally {
        verify.mockRestore();
      }
    });
  },
);
