import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { searchSessionTranscriptsReadOnlySync as searchSessionTranscripts } from "../config/sessions/session-transcript-search.js";
import * as sessionTargets from "../config/sessions/targets.js";
import {
  readMigrationArtifactIdentity,
  moveMigrationArtifact,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  recordPlannedMigrationMoves,
  recordCompletedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationMove,
} from "../infra/session-sqlite-migration-manifest.js";
import * as migrationRun from "../infra/session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectRecoveryInventory } from "./doctor-session-sqlite-recovery-inventory.js";
import { restoreSessionSqliteMigrationRun } from "./doctor-session-sqlite-restore.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

function transcript(id: string, phrase: string) {
  return (
    [
      {
        type: "session",
        id,
        version: 3,
        timestamp: "2026-06-15T00:00:00.000Z",
        cwd: "/legacy/workspace",
      },
      {
        type: "message",
        id: `${id}-user`,
        parentId: null,
        timestamp: "2026-06-15T00:00:01.000Z",
        message: { role: "user", content: phrase },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n"
  );
}

it("retains growing duplicate archives and the restore refusal without leaking its descriptor", async () => {
  await withOpenClawTestState({ label: "doctor-restore-growing-archive" }, async (state) => {
    fs.mkdirSync(state.sessionsDir(), { recursive: true });
    const sessions = fs.realpathSync(state.sessionsDir());
    const storePath = path.join(sessions, "sessions.json");
    const target = {
      agentId: "main",
      storePath,
      sqlitePath: resolveTargetSqlitePath({ agentId: "main", storePath }, state.env),
    };
    const archiveDir = path.join(path.dirname(sessions), "session-sqlite-import-archive");
    fs.mkdirSync(archiveDir);
    const sourcePath = path.join(sessions, "session.jsonl");
    const archivePath = path.join(archiveDir, "session.jsonl.imported-1");
    const duplicatePath = `${archivePath}.duplicate`;
    const original = transcript("session", "x".repeat(128 * 1024));
    fs.writeFileSync(archivePath, original);
    fs.copyFileSync(archivePath, duplicatePath);
    const run = createSessionSqliteMigrationRun(state.env, [target]);
    recordPlannedMigrationMoves(run, target, [
      { kind: "transcript", sourcePath, archivePath },
      { kind: "transcript", sourcePath, archivePath: duplicatePath },
    ]);
    const identity = fs.statSync(archivePath);
    const read = fs.readSync;
    let descriptor: number | undefined;
    const reads = vi
      .spyOn(fs, "readSync")
      .mockImplementation(
        (
          fd: number,
          buffer: NodeJS.ArrayBufferView,
          offsetOrOptions: number | fs.ReadOptions = {},
          length?: number,
          position?: fs.ReadPosition | null,
        ) => {
          const opened = fs.fstatSync(fd);
          if (
            descriptor === undefined &&
            opened.dev === identity.dev &&
            opened.ino === identity.ino
          ) {
            descriptor = fd;
            fs.appendFileSync(archivePath, "\n");
          }
          return read(
            fd,
            buffer,
            typeof offsetOrOptions === "number"
              ? { offset: offsetOrOptions, length, position }
              : offsetOrOptions,
          );
        },
      );
    let report: Awaited<ReturnType<typeof restoreSessionSqliteMigrationRun>>;
    try {
      report = await restoreSessionSqliteMigrationRun({
        env: state.env,
        manifestPath: run.manifestPath,
        trustedTargets: [target],
      });
    } finally {
      reads.mockRestore();
    }
    expect(descriptor).toBeTypeOf("number");
    expect(() => fs.fstatSync(descriptor!)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(report.conflicts).toContainEqual({
      sourcePath,
      archivePath,
      reason: "archive changed while it was inspected; refusing restore",
    });
    expect(report.restoredFiles).toEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.readFileSync(archivePath, "utf8")).toBe(`${original}\n`);
    expect(fs.readFileSync(duplicatePath, "utf8")).toBe(original);
    const recorded = migrationRun.readSessionSqliteMigrationManifest(run.manifestPath);
    expect(recorded?.restore?.consumedArchives ?? []).not.toContain(archivePath);
    expect(recorded?.restore?.restoredFiles).toEqual([]);
  });
});

it.each(["dry-run", "import", "validate"] as const)(
  "%s carries one fleet discovery into legacy archive coverage",
  async (mode) => {
    await withOpenClawTestState({ label: "doctor-fleet-discovery" }, async (state) => {
      const agentIds = ["first", "second", "third"];
      for (const agentId of agentIds) {
        const sessions = state.sessionsDir(agentId);
        fs.mkdirSync(sessions, { recursive: true });
        fs.writeFileSync(path.join(sessions, "sessions.json"), "{}");
      }
      const discovery = vi.spyOn(sessionTargets, "resolveAllAgentSessionStoreCandidateTargetsSync");
      try {
        const report = await runDoctorSessionSqlite({
          mode,
          allAgents: true,
          cfg: {},
          env: state.env,
        });
        expect(report.targets.map((target) => target.agentId).toSorted()).toEqual(agentIds);
        expect(discovery).toHaveBeenCalledTimes(1);
      } finally {
        discovery.mockRestore();
      }
    });
  },
);

it.each([{ allAgents: true }, { agent: "retired" }])(
  "admits transcript-only retired agents through the public selector %j",
  async (selector) => {
    await withOpenClawTestState({ label: "doctor-transcript-only" }, async (state) => {
      const sessions = state.sessionsDir("retired");
      fs.mkdirSync(sessions, { recursive: true });
      const store = path.join(sessions, "sessions.json");
      const id = "77777777-7777-4777-8777-777777777777";
      const source = path.join(sessions, `${id}.jsonl`);
      const bytes = transcript(id, "retiredhistoryneedle");
      fs.writeFileSync(source, bytes);
      const sqlitePath = resolveTargetSqlitePath(
        { agentId: "retired", storePath: store },
        state.env,
      );
      expect(fs.existsSync(store)).toBe(false);
      expect(fs.existsSync(sqlitePath)).toBe(false);
      for (const mode of ["dry-run", "validate"] as const) {
        const report = await runDoctorSessionSqlite({ mode, ...selector, cfg: {}, env: state.env });
        expect(report.targets).toEqual([
          expect.objectContaining({ agentId: "retired", legacyEntries: 1 }),
        ]);
        expect(fs.existsSync(sqlitePath)).toBe(false);
        expect(fs.readFileSync(source, "utf8")).toBe(bytes);
      }
      const report = await runDoctorSessionSqlite({
        mode: "import",
        ...selector,
        cfg: {},
        env: state.env,
      });
      expect(report.totals.importedEntries).toBe(1);
      expect(report.targets.flatMap((target) => target.issues)).toEqual([]);
      closeOpenClawAgentDatabasesForTest();
      expect(
        searchSessionTranscripts({
          agentId: "retired",
          env: state.env,
          query: "retiredhistoryneedle",
        }).hits,
      ).toEqual([expect.objectContaining({ sessionId: id })]);
      const archived = report.targets.flatMap((target) => target.archivedTranscriptFiles);
      expect(archived).toHaveLength(1);
      expect(fs.readFileSync(archived[0]!, "utf8")).toBe(bytes);
      expect(
        (
          await runDoctorSessionSqlite({
            mode: "import",
            ...selector,
            cfg: {},
            env: state.env,
          })
        ).totals.importedEntries,
      ).toBe(0);
    });
  },
);

it("imports valid unregistered primary history without changing its current logical owner", async () => {
  await withOpenClawTestState({ label: "doctor-discovery" }, async (state) => {
    const sessions = state.sessionsDir();
    fs.mkdirSync(sessions, { recursive: true });
    const store = path.join(sessions, "sessions.json");
    const key = "agent:main:main";
    const previous = "11111111-1111-4111-8111-111111111111";
    const standalone = "22222222-2222-4222-8222-222222222222";
    const priorName = `2026-06-15T00-00-00-000Z_${previous}.jsonl`;
    fs.writeFileSync(
      store,
      JSON.stringify({
        [key]: {
          sessionId: "current",
          updatedAt: 42,
          sessionFile: "current.jsonl",
          previousSessionId: previous,
        },
      }),
    );
    fs.writeFileSync(path.join(sessions, "current.jsonl"), transcript("current", "currentword"));
    fs.writeFileSync(path.join(sessions, priorName), transcript(previous, "oldfamilyneedle"));
    fs.writeFileSync(
      path.join(sessions, `${standalone}.jsonl`),
      transcript(standalone, "oldstandaloneneedle"),
    );
    const report = await runDoctorSessionSqlite({ mode: "import", store, env: state.env });
    expect(report.targets.flatMap((target) => target.issues)).toEqual([]);
    const scope = { agentId: "main", env: state.env };
    expect(searchSessionTranscripts({ ...scope, query: "oldfamilyneedle" }).hits).toEqual([
      expect.objectContaining({ sessionKey: key, sessionId: previous }),
    ]);
    expect(searchSessionTranscripts({ ...scope, query: "oldstandaloneneedle" }).hits).toHaveLength(
      1,
    );
    expect(
      loadExactSessionEntry({ ...scope, sessionKey: key, storePath: store })?.entry,
    ).toMatchObject({
      sessionId: "current",
      updatedAt: 42,
    });
  });
});

it("recovers a completed old archive once, preserves bytes, and does not resurrect user-deleted history", async () => {
  await withOpenClawTestState({ label: "doctor-archive-discovery" }, async (state) => {
    const sessions = state.sessionsDir();
    fs.mkdirSync(sessions, { recursive: true });
    const store = path.join(sessions, "sessions.json");
    const id = "33333333-3333-4333-8333-333333333333";
    const original = path.join(sessions, `${id}.jsonl`);
    const bytes = transcript(id, "archivedneedle");
    fs.writeFileSync(original, bytes);
    const target = {
      agentId: "main",
      storePath: store,
      sqlitePath: resolveTargetSqlitePath({ agentId: "main", storePath: store }, state.env),
    };
    const archive = path.join(
      path.dirname(sessions),
      "session-sqlite-import-archive",
      `archive-tier.${id}.jsonl.imported-1`,
    );
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const old = createSessionSqliteMigrationRun(state.env, [target]);
    const move: SessionSqliteMigrationMove = {
      kind: "unreferenced-jsonl",
      sourcePath: original,
      archivePath: archive,
      artifact: {
        identity: readMigrationArtifactIdentity(original),
        classification: "protected",
        reason: "unreferenced-history",
        dependencies: [],
        disposal: { state: "retained" },
      },
    };
    recordPlannedMigrationMoves(old, target, [move]);
    await moveMigrationArtifact(original, archive, move.artifact!.identity);
    recordCompletedMigrationMoves(old, target, [move]);
    updateMigrationManifestTarget(old, target, [], { validationBeforeArchive: "passed" });
    old.manifest.completedAt = new Date().toISOString();
    writeSessionSqliteMigrationManifest(old);
    const completed = migrationRun.recordCompletedMigrationMoves;
    const interrupted = vi
      .spyOn(migrationRun, "recordCompletedMigrationMoves")
      .mockImplementation((run, owner, moves) => {
        if (
          moves.some(
            (candidateMove) => candidateMove.artifact?.reason === "indexed-historical-primary",
          )
        ) {
          throw new Error("simulated interruption before recovery receipt");
        }
        return completed(run, owner, moves);
      });
    try {
      await expect(
        runDoctorSessionSqlite({ mode: "import", store, env: state.env }),
      ).rejects.toThrow("simulated interruption");
    } finally {
      interrupted.mockRestore();
      closeOpenClawAgentDatabasesForTest();
    }
    const report = await runDoctorSessionSqlite({ mode: "import", store, env: state.env });
    expect(report.targets.flatMap((item) => item.issues)).toEqual([]);
    expect(report.totals.importedEntries).toBe(1);
    const scope = { agentId: "main", env: state.env };
    const hit = searchSessionTranscripts({ ...scope, query: "archivedneedle" }).hits[0];
    expect(hit).toMatchObject({ sessionId: id });
    expect(fs.readFileSync(archive, "utf8")).toBe(bytes);
    closeOpenClawAgentDatabasesForTest();
    expect(searchSessionTranscripts({ ...scope, query: "archivedneedle" }).hits).toHaveLength(1);
    expect(
      (await runDoctorSessionSqlite({ mode: "import", store, env: state.env })).totals
        .importedEntries,
    ).toBe(0);
    const key = hit!.sessionKey;
    await deleteSessionEntryLifecycle({
      ...scope,
      storePath: store,
      target: { canonicalKey: key, storeKeys: [key] },
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
    });
    expect(searchSessionTranscripts({ ...scope, query: "archivedneedle" }).hits).toEqual([]);
    // Keep the acknowledgment when a later unacknowledged move coalesces onto it.
    const duplicate = `${archive}.duplicate`;
    fs.copyFileSync(archive, duplicate);
    const acknowledged = {
      manifestPath: report.migrationRun!.manifestPath,
      manifest: migrationRun.readSessionSqliteMigrationManifest(report.migrationRun!.manifestPath)!,
    };
    const duplicateMove: SessionSqliteMigrationMove = {
      ...move,
      archivePath: duplicate,
      artifact: { ...move.artifact!, identity: readMigrationArtifactIdentity(duplicate) },
    };
    recordPlannedMigrationMoves(acknowledged, target, [duplicateMove]);
    recordCompletedMigrationMoves(acknowledged, target, [duplicateMove]);
    const settled = await runDoctorSessionSqlite({ mode: "import", store, env: state.env });
    expect(settled.targets.flatMap((item) => item.issues)).toEqual([
      expect.objectContaining({ code: "historical_duplicate_settled" }),
    ]);
    expect(settled.totals.importedEntries).toBe(0);
    expect(fs.existsSync(duplicate)).toBe(false);
    expect(
      migrationRun.readSessionSqliteMigrationManifest(acknowledged.manifestPath)?.targets[0]
        ?.completedMoves,
    ).toEqual([
      expect.objectContaining({
        archivePath: archive,
        artifact: expect.objectContaining({ reason: "indexed-historical-primary" }),
      }),
    ]);
    expect(
      (await runDoctorSessionSqlite({ mode: "import", store, env: state.env })).totals
        .importedEntries,
    ).toBe(0);
    expect(searchSessionTranscripts({ ...scope, query: "archivedneedle" }).hits).toEqual([]);
    expect(fs.readFileSync(archive, "utf8")).toBe(bytes);
  });
});

it.each(["import", "recover"] as const)(
  "%s settles identical repeated archives across retained manifests and names differing pairs",
  async (mode) => {
    await withOpenClawTestState({ label: "doctor-duplicate-archives" }, async (state) => {
      const sessions = state.sessionsDir();
      fs.mkdirSync(sessions, { recursive: true });
      const store = path.join(sessions, "sessions.json");
      const target = {
        agentId: "main",
        storePath: store,
        sqlitePath: resolveTargetSqlitePath({ agentId: "main", storePath: store }, state.env),
      };
      const archiveDir = path.join(path.dirname(sessions), "session-sqlite-import-archive");
      fs.mkdirSync(archiveDir);
      const ids = ["identical", "different-1", "different-2", "different-3", "different-4"];
      const originals = new Map<string, string>();
      const moves: SessionSqliteMigrationMove[] = [];
      const manifests: string[] = [];
      for (let copy = 1; copy <= 2; copy++) {
        const old = createSessionSqliteMigrationRun(state.env, [target]);
        manifests.push(old.manifestPath);
        for (const id of ids) {
          const sourcePath = path.join(sessions, `${id}.jsonl`);
          const archivePath = path.join(archiveDir, `${id}.jsonl.imported-${copy}`);
          const bytes = transcript(id, id === "identical" ? "duplicateneedle" : `${id}-${copy}`);
          originals.set(archivePath, bytes);
          fs.writeFileSync(sourcePath, bytes);
          const move: SessionSqliteMigrationMove = {
            kind: "unreferenced-jsonl",
            sourcePath,
            archivePath,
            artifact: {
              identity: readMigrationArtifactIdentity(sourcePath),
              classification: "protected",
              reason: "unreferenced-history",
              dependencies: [],
              disposal: { state: "retained" },
            },
          };
          recordPlannedMigrationMoves(old, target, [move]);
          await moveMigrationArtifact(sourcePath, archivePath, move.artifact!.identity);
          recordCompletedMigrationMoves(old, target, [move]);
          moves.push(move);
        }
        updateMigrationManifestTarget(old, target, [], { validationBeforeArchive: "passed" });
        old.manifest.completedAt = new Date().toISOString();
        writeSessionSqliteMigrationManifest(old);
      }
      // Later retries retained both source claims; the latest failed run moved nothing.
      for (let attempt = 0; attempt < 3; attempt++) {
        const retry = createSessionSqliteMigrationRun(state.env, [target]);
        manifests.push(retry.manifestPath);
        recordPlannedMigrationMoves(retry, target, attempt < 2 ? moves : []);
        retry.manifest.failedAt = new Date().toISOString();
        writeSessionSqliteMigrationManifest(retry);
      }
      const dry = await runDoctorSessionSqlite({ mode: "dry-run", store, env: state.env });
      expect(dry.totals.legacyEntries).toBe(1);
      expect(
        dry.targets[0]!.issues.filter((issue) => issue.code === "historical_transcript_deferred"),
      ).toHaveLength(4);
      expect(fs.readdirSync(archiveDir)).toHaveLength(10);
      const report = await runDoctorSessionSqlite({ mode, store, env: state.env });
      expect(report.targets.flatMap((item) => item.issues)).toContainEqual({
        code: "historical_duplicate_settled",
        message: expect.stringContaining("Retired 1 byte-identical duplicate archive(s)"),
      });
      const deferred = report.targets
        .flatMap((item) => item.issues)
        .filter((issue) => issue.code === "historical_transcript_deferred");
      expect(deferred).toHaveLength(4);
      for (const id of ids.slice(1)) {
        expect(
          deferred.some((issue) => issue.message.startsWith(`${id}: multiple primary files`)),
        ).toBe(true);
      }
      expect(
        searchSessionTranscripts({ agentId: "main", env: state.env, query: "duplicateneedle" })
          .hits,
      ).toEqual([expect.objectContaining({ sessionId: "identical" })]);
      const identical = moves.filter(
        (move) => path.basename(move.sourcePath) === "identical.jsonl",
      );
      expect(identical.filter((move) => fs.existsSync(move.archivePath))).toHaveLength(1);
      for (const [file, bytes] of originals) {
        if (!path.basename(file).startsWith("identical.")) {
          expect(fs.readFileSync(file, "utf8")).toBe(bytes);
        }
      }
      const retired = identical.find((move) => !fs.existsSync(move.archivePath))!;
      const survivor = identical.find((move) => fs.existsSync(move.archivePath))!;
      expect(fs.readFileSync(survivor.archivePath, "utf8")).toBe(
        originals.get(survivor.archivePath),
      );
      for (const file of manifests) {
        const manifest = migrationRun.readSessionSqliteMigrationManifest(file)!;
        for (const item of manifest.targets) {
          for (const list of [item.plannedMoves, item.completedMoves]) {
            expect(list.map((move) => move.archivePath)).not.toContain(retired.archivePath);
            const canonical = list.filter((move) => move.sourcePath === retired.sourcePath);
            if (canonical.length > 0) {
              expect(canonical).toEqual([
                expect.objectContaining({
                  archivePath: survivor.archivePath,
                  artifact: expect.objectContaining({ disposal: { state: "retained" } }),
                }),
              ]);
            }
          }
        }
      }
      expect(
        collectRecoveryInventory({ cfg: {}, env: state.env }).report.artifacts,
      ).not.toContainEqual(expect.objectContaining({ reason: "unexpectedly-missing-artifact" }));
      for (const next of ["dry-run", "recover"] as const) {
        const repeated = await runDoctorSessionSqlite({ mode: next, store, env: state.env });
        expect(repeated.targets.flatMap((item) => item.issues)).toEqual(deferred);
        expect(repeated.totals.importedEntries).toBe(0);
      }
    });
  },
);

it("keeps diagnostic, deleted, mismatched, and ambiguous inputs out of searchable history", async () => {
  await withOpenClawTestState({ label: "doctor-discovery-negative" }, async (state) => {
    const sessions = state.sessionsDir();
    fs.mkdirSync(sessions, { recursive: true });
    const store = path.join(sessions, "sessions.json");
    fs.writeFileSync(store, "{}");
    const primary = "44444444-4444-4444-8444-444444444444";
    const duplicate = "55555555-5555-4555-8555-555555555555";
    const files = new Map([
      [`${primary}.jsonl`, transcript(primary, "eligibleprimaryneedle")],
      [
        `${primary}.trajectory.jsonl`,
        JSON.stringify({
          traceSchema: "openclaw-trajectory",
          message: { role: "user", content: "diagnosticneedle" },
        }) + "\n",
      ],
      ["deleted.jsonl.deleted.2026-07-01T00-00-00.000Z", transcript("deleted", "deletedneedle")],
      ["mismatch.jsonl", transcript("different", "mismatchneedle")],
      ["malformed.jsonl", '{"type":"session","id":"malformed","version":3}\ninvalid\n'],
      [`${duplicate}.jsonl`, transcript(duplicate, "ambiguousneedle")],
      [
        `2026-06-15T00-00-00-000Z_${duplicate}.jsonl`,
        transcript(duplicate, "secondambiguousneedle"),
      ],
    ]);
    for (const [name, bytes] of files) {
      fs.writeFileSync(path.join(sessions, name), bytes);
    }
    const archivedId = "88888888-8888-4888-8888-888888888888";
    const archivedBytes = transcript(archivedId, "distinctoriginalneedle");
    const target = {
      agentId: "main",
      storePath: store,
      sqlitePath: resolveTargetSqlitePath({ agentId: "main", storePath: store }, state.env),
    };
    const old = createSessionSqliteMigrationRun(state.env, [target]);
    const archiveDir = path.join(path.dirname(sessions), "session-sqlite-import-archive");
    fs.mkdirSync(archiveDir);
    const archivedPaths: string[] = [];
    for (const name of [`${archivedId}.jsonl`, `2026-06-15T00-00-00-000Z_${archivedId}.jsonl`]) {
      const sourcePath = path.join(sessions, name);
      const archivePath = path.join(archiveDir, `${name}.imported-1`);
      fs.writeFileSync(sourcePath, archivedBytes);
      const move: SessionSqliteMigrationMove = {
        kind: "unreferenced-jsonl",
        sourcePath,
        archivePath,
        artifact: {
          identity: readMigrationArtifactIdentity(sourcePath),
          classification: "protected",
          reason: "unreferenced-history",
          dependencies: [],
          disposal: { state: "retained" },
        },
      };
      recordPlannedMigrationMoves(old, target, [move]);
      await moveMigrationArtifact(sourcePath, archivePath, move.artifact!.identity);
      recordCompletedMigrationMoves(old, target, [move]);
      archivedPaths.push(archivePath);
    }
    updateMigrationManifestTarget(old, target, [], { validationBeforeArchive: "passed" });
    old.manifest.completedAt = old.manifest.startedAt;
    writeSessionSqliteMigrationManifest(old);
    const report = await runDoctorSessionSqlite({ mode: "import", store, env: state.env });
    expect(report.totals.importedEntries).toBe(1);
    expect(report.targets[0]!.issues.map((issue) => issue.code)).toEqual([
      "historical_transcript_deferred",
      "historical_transcript_deferred",
      "historical_transcript_deferred",
      "historical_transcript_deferred",
    ]);
    expect(report.targets[0]!.issues).toContainEqual({
      code: "historical_transcript_deferred",
      message: `${archivedId}: multiple primary files claim this identity; originals retained without importing`,
    });
    const scope = { agentId: "main", env: state.env };
    expect(
      searchSessionTranscripts({ ...scope, query: "eligibleprimaryneedle" }).hits,
    ).toHaveLength(1);
    for (const query of [
      "diagnosticneedle",
      "deletedneedle",
      "mismatchneedle",
      "ambiguousneedle",
      "secondambiguousneedle",
      "distinctoriginalneedle",
    ]) {
      expect(searchSessionTranscripts({ ...scope, query }).hits).toEqual([]);
    }
    const manifest = JSON.parse(fs.readFileSync(report.migrationRun!.manifestPath, "utf8"));
    const moves: SessionSqliteMigrationMove[] = manifest.targets.flatMap(
      (item: { completedMoves: SessionSqliteMigrationMove[] }) => item.completedMoves,
    );
    for (const [name, bytes] of files) {
      const source = path.join(sessions, name);
      const move = moves.find((candidate) => candidate.sourcePath === source);
      expect(fs.readFileSync(move?.archivePath ?? source, "utf8")).toBe(bytes);
    }
    for (const archivePath of archivedPaths) {
      expect(fs.readFileSync(archivePath, "utf8")).toBe(archivedBytes);
    }
  });
});

it.each(["unchanged", "metadata changed", "contents changed"])(
  "uses a 2026.9.4 archived registry under current SQLite state: %s",
  async (archiveState) => {
    await withOpenClawTestState({ label: "doctor-archived-lineage" }, async (state) => {
      const sessions = state.sessionsDir();
      fs.mkdirSync(sessions, { recursive: true });
      const store = path.join(sessions, "sessions.json");
      const key = "agent:main:main";
      const id = "66666666-6666-4666-8666-666666666666";
      const original = path.join(sessions, `2026-06-15T00-00-00-000Z_${id}.jsonl`);
      fs.writeFileSync(original, transcript(id, "archivedfamilyneedle"));
      fs.writeFileSync(
        store,
        JSON.stringify({
          [key]: {
            sessionId: "old-current",
            updatedAt: 1,
            previousSessionId: id,
            usageFamilySessionIds: [id],
          },
        }),
      );
      const target = {
        agentId: "main",
        storePath: store,
        sqlitePath: resolveTargetSqlitePath({ agentId: "main", storePath: store }, state.env),
      };
      const old = createSessionSqliteMigrationRun(state.env, [target]);
      // v2026.9.4 wrote manifest v3 with the same dev/ino/mtimeNs/size/sha256 identity.
      old.manifest.openClawVersion = "2026.9.4";
      old.manifest.manifestVersion = 3;
      const archiveDir = path.join(path.dirname(sessions), "session-sqlite-import-archive");
      fs.mkdirSync(archiveDir, { recursive: true });
      const saved = new Map<string, string>();
      for (const source of [store, original]) {
        const archivePath = path.join(
          archiveDir,
          `${source === store ? "legacy-store" : "archive-tier"}.${path.basename(source)}.imported-1788290346376`,
        );
        const move: SessionSqliteMigrationMove = {
          kind: source === store ? "legacy-store" : "unreferenced-jsonl",
          sourcePath: source,
          archivePath,
          artifact: {
            identity: readMigrationArtifactIdentity(source),
            classification: source === store ? "imported" : "protected",
            reason: source === store ? "verified-index-import" : "unreferenced-history",
            dependencies: [],
            disposal: { state: "retained" },
          },
        };
        saved.set(archivePath, fs.readFileSync(source, "utf8"));
        recordPlannedMigrationMoves(old, target, [move]);
        await moveMigrationArtifact(source, archivePath, move.artifact!.identity);
        recordCompletedMigrationMoves(old, target, [move]);
      }
      updateMigrationManifestTarget(old, target, [], { validationBeforeArchive: "passed" });
      old.manifest.completedAt = new Date().toISOString();
      writeSessionSqliteMigrationManifest(old);
      const scope = { agentId: "main", env: state.env };
      await importSqliteSessionRows({
        ...scope,
        storePath: store,
        sessionKey: key,
        entry: {
          sessionId: "new-current",
          updatedAt: 999,
          pinnedAt: 998,
          label: "newer-user-label",
        },
      });
      const before = loadExactSessionEntry({ ...scope, storePath: store, sessionKey: key });
      const preview = await runDoctorSessionSqlite({ mode: "dry-run", store, env: state.env });
      expect(preview.totals).toMatchObject({ legacyEntries: 1, issues: 0, sqliteEntries: 1 });
      if (archiveState !== "unchanged") {
        const registry = [...saved.keys()].find((file) => file.includes("legacy-store."))!;
        if (archiveState === "metadata changed") {
          fs.utimesSync(registry, new Date(0), new Date(0));
        } else {
          fs.appendFileSync(registry, "\n");
          saved.set(registry, saved.get(registry)! + "\n");
        }
        for (const mode of ["dry-run", "validate", "import", "import"] as const) {
          const report = await runDoctorSessionSqlite({ mode, store, env: state.env });
          expect(report.totals).toMatchObject({
            importedEntries: 0,
            importedTranscriptEvents: 0,
            issues: 1,
            sqliteEntries: 1,
          });
          const issue = report.targets[0]!.issues[0]!;
          expect(issue.code).toBe("historical_transcript_deferred");
          expect(issue.message).toContain("no longer matches its migration receipt");
          expect(issue.message).toContain("Historical transcript import skipped");
          expect(issue.message).toContain("does not indicate SQLite corruption");
          expect(issue.message).toContain(
            "No action is needed if all expected conversations are present",
          );
          expect(issue.message).toContain(
            "https://docs.openclaw.ai/cli/doctor/sqlite-maintenance#changed-archived-registry",
          );
          expect(issue.message).not.toContain("Error:");
          if (report.migrationRun) {
            const receipt = migrationRun.readSessionSqliteMigrationManifest(
              report.migrationRun.manifestPath,
            )!;
            expect(receipt.targets[0]!.issues).toEqual([issue]);
            expect(receipt.failedAt).toBeUndefined();
            expect(receipt.targets[0]!.completedMoves).toEqual([]);
          }
        }
        const inspected = await runDoctorSessionSqlite({ mode: "inspect", store, env: state.env });
        expect(inspected.totals).toMatchObject({ sqliteEntries: 1, issues: 0 });
        expect(searchSessionTranscripts({ ...scope, query: "archivedfamilyneedle" }).hits).toEqual(
          [],
        );
      } else {
        const report = await runDoctorSessionSqlite({ mode: "import", store, env: state.env });
        expect(report.targets.flatMap((item) => item.issues)).toEqual([]);
        expect(searchSessionTranscripts({ ...scope, query: "archivedfamilyneedle" }).hits).toEqual([
          expect.objectContaining({ sessionId: id, sessionKey: key }),
        ]);
      }
      expect(loadExactSessionEntry({ ...scope, storePath: store, sessionKey: key })).toEqual(
        before,
      );
      for (const [archivePath, bytes] of saved) {
        expect(fs.readFileSync(archivePath, "utf8")).toBe(bytes);
      }
    });
  },
);

it("resolves one generated primary for a missing registry filename at the Doctor boundary", async () => {
  await withOpenClawTestState({ label: "doctor-generated-current" }, async (state) => {
    const sessions = state.sessionsDir();
    fs.mkdirSync(sessions, { recursive: true });
    const store = path.join(sessions, "sessions.json");
    const id = "77777777-7777-4777-8777-777777777777";
    const key = "agent:main:main";
    fs.writeFileSync(
      store,
      JSON.stringify({
        [key]: {
          sessionId: id,
          updatedAt: 123,
          sessionFile: `${id}.jsonl`,
          label: "retained-label",
        },
      }),
    );
    fs.writeFileSync(
      path.join(sessions, `2026-06-15T00-00-00-000Z_${id}.jsonl`),
      transcript(id, "generatedcurrentneedle"),
    );
    const report = await runDoctorSessionSqlite({ mode: "import", store, env: state.env });
    expect(report.targets.flatMap((item) => item.issues)).toEqual([]);
    const scope = { agentId: "main", env: state.env };
    expect(searchSessionTranscripts({ ...scope, query: "generatedcurrentneedle" }).hits).toEqual([
      expect.objectContaining({ sessionKey: key, sessionId: id }),
    ]);
    expect(
      loadExactSessionEntry({ ...scope, sessionKey: key, storePath: store })?.entry,
    ).toMatchObject({
      sessionId: id,
      updatedAt: 123,
      label: "retained-label",
    });
  });
});

it.each([1, 2, 3])(
  "imports validated version %i history through the legacy codec",
  async (version) => {
    await withOpenClawTestState({ label: "doctor-historical-version" }, async (state) => {
      const sessions = state.sessionsDir();
      fs.mkdirSync(sessions, { recursive: true });
      const store = path.join(sessions, "sessions.json");
      const id = `legacy-version-${version}`;
      const header = {
        type: "session",
        id,
        version,
        timestamp: "2026-06-15T00:00:00.000Z",
        cwd: "/legacy/workspace",
      };
      const event = {
        type: "message",
        ...(version > 1 ? { id: "old-user", parentId: null } : {}),
        timestamp: "2026-06-15T00:00:01.000Z",
        message: { role: "user", content: "legacyversionneedle" },
      };
      const bytes = `${JSON.stringify(header)}\n${JSON.stringify(event)}\n`;
      fs.writeFileSync(path.join(sessions, `${id}.jsonl`), bytes);
      const report = await runDoctorSessionSqlite({ mode: "import", store, env: state.env });
      expect(report.targets.flatMap((item) => item.issues)).toEqual([]);
      closeOpenClawAgentDatabasesForTest();
      expect(
        searchSessionTranscripts({ agentId: "main", env: state.env, query: "legacyversionneedle" })
          .hits,
      ).toEqual([expect.objectContaining({ sessionId: id })]);
    });
  },
);

it("preserves retained shared aliases after the old migration cleared their filenames", async () => {
  await withOpenClawTestState({ label: "doctor-shared-archive" }, async (state) => {
    const sessions = state.sessionsDir();
    fs.mkdirSync(sessions, { recursive: true });
    const store = path.join(sessions, "sessions.json");
    const id = "shared-session";
    const entries = {
      "agent:main:shared-a": { sessionId: id, updatedAt: 42 },
      "agent:main:shared-b": { sessionId: id, updatedAt: 43 },
    };
    fs.writeFileSync(store, JSON.stringify(entries));
    for (const [sessionKey, entry] of Object.entries(entries)) {
      await importSqliteSessionRows({ agentId: "main", storePath: store, sessionKey, entry });
    }
    const target = {
      agentId: "main",
      storePath: store,
      sqlitePath: resolveTargetSqlitePath({ agentId: "main", storePath: store }, state.env),
    };
    const archiveDir = path.join(path.dirname(sessions), "session-sqlite-import-archive");
    fs.mkdirSync(archiveDir, { recursive: true });
    const old = createSessionSqliteMigrationRun(state.env, [target]);
    const originals = new Map<string, string>();
    for (const name of ["sessions.json", "shared-a.jsonl", "shared-b.jsonl"]) {
      const source = path.join(sessions, name);
      if (name !== "sessions.json") {
        fs.writeFileSync(source, transcript(id, "sharedaliasneedle"));
      }
      const archive = path.join(archiveDir, `archive-tier.${name}.imported-1`);
      originals.set(archive, fs.readFileSync(source, "utf8"));
      const move: SessionSqliteMigrationMove = {
        kind: name === "sessions.json" ? "legacy-store" : "unreferenced-jsonl",
        sourcePath: source,
        archivePath: archive,
        artifact: {
          identity: readMigrationArtifactIdentity(source),
          classification: "protected",
          reason: "unreferenced-history",
          dependencies: [],
          disposal: { state: "retained" },
        },
      };
      recordPlannedMigrationMoves(old, target, [move]);
      await moveMigrationArtifact(source, archive, move.artifact!.identity);
      recordCompletedMigrationMoves(old, target, [move]);
    }
    updateMigrationManifestTarget(old, target, [], { validationBeforeArchive: "passed" });
    old.manifest.completedAt = new Date().toISOString();
    writeSessionSqliteMigrationManifest(old);
    for (const mode of ["validate", "import"] as const) {
      const report = await runDoctorSessionSqlite({ mode, store, env: state.env });
      expect(report.totals).toMatchObject({
        importedEntries: 0,
        importedTranscriptEvents: 0,
        issues: 0,
      });
    }
    for (const [archive, bytes] of originals) {
      expect(fs.readFileSync(archive, "utf8")).toBe(bytes);
    }
    for (const [sessionKey, entry] of Object.entries(entries)) {
      expect(
        loadExactSessionEntry({ agentId: "main", storePath: store, sessionKey })?.entry,
      ).toMatchObject(entry);
    }
    expect(
      searchSessionTranscripts({ agentId: "main", env: state.env, query: "sharedaliasneedle" })
        .hits,
    ).toEqual([]);
  });
});
