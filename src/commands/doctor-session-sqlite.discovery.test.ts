import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import { loadExactSessionEntry as loadEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { searchSessionTranscriptsReadOnlySync as searchTranscripts } from "../config/sessions/session-transcript-search.js";
import {
  readMigrationArtifactIdentity,
  moveMigrationArtifact,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  readSessionSqliteMigrationManifest as readManifest,
  recordPlannedMigrationMoves,
  recordCompletedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationMove,
} from "../infra/session-sqlite-migration-manifest.js";
import * as migrationRun from "../infra/session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import { closeOpenClawAgentDatabasesForTest as closeAgentHandles } from "../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { collectRecoveryInventory } from "./doctor-session-sqlite-recovery-inventory.js";
import { restoreSessionSqliteMigrationRun } from "./doctor-session-sqlite-restore.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

type MigrationTarget = Parameters<typeof createSessionSqliteMigrationRun>[1][number];
type MigrationRun = ReturnType<typeof createSessionSqliteMigrationRun>;
type DoctorReport = Awaited<ReturnType<typeof runDoctorSessionSqlite>>;
const noImports = { importedEntries: 0, importedTranscriptEvents: 0 };
const issues = (report: DoctorReport) => report.targets.flatMap((target) => target.issues);
function expectBytes(files: Iterable<readonly [string, string]>) {
  for (const [file, bytes] of files) {
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
  }
}
function writeJson(file: string, data: unknown) {
  fs.writeFileSync(file, JSON.stringify(data));
}
function discoveryState(state: OpenClawTestState) {
  fs.mkdirSync(state.sessionsDir(), { recursive: true });
  const sessions = fs.realpathSync(state.sessionsDir());
  const store = path.join(sessions, "sessions.json");
  const scope = { agentId: "main", env: state.env };
  return {
    sessions,
    store,
    target: {
      agentId: "main",
      storePath: store,
      sqlitePath: resolveTargetSqlitePath({ agentId: "main", storePath: store }, state.env),
    },
    archiveDir: path.join(path.dirname(sessions), "session-sqlite-import-archive"),
    scope,
    search: (query: string) => searchTranscripts({ ...scope, query }).hits,
    writeTranscript: (name: string, id: string, phrase: string) =>
      fs.writeFileSync(path.join(sessions, name), transcript(id, phrase)),
    entry: (sessionKey: string) => loadEntry({ ...scope, sessionKey, storePath: store }),
    run: (mode: Parameters<typeof runDoctorSessionSqlite>[0]["mode"]) =>
      runDoctorSessionSqlite({ mode, store, env: state.env }),
  };
}
async function retainSources(
  state: OpenClawTestState,
  sources: string[],
  { version, remounted = false }: { version?: string; remounted?: boolean } = {},
) {
  const { store, target, archiveDir } = discoveryState(state);
  fs.mkdirSync(archiveDir, { recursive: true });
  const old = createSessionSqliteMigrationRun(state.env, [target]);
  if (version) {
    Object.assign(old.manifest, { openClawVersion: version, manifestVersion: 3 });
  }
  const originals = new Map<string, string>();
  for (const source of sources) {
    const archive = path.join(
      archiveDir,
      `${source === store ? "legacy-store" : "archive-tier"}.${path.basename(source)}.imported-1`,
    );
    originals.set(archive, fs.readFileSync(source, "utf8"));
    await publishArchive(old, target, source, archive, {
      kind: source === store ? "legacy-store" : "unreferenced-jsonl",
      imported: Boolean(version) && source === store,
      remounted,
    });
  }
  completeRun(old, target);
  return originals;
}
async function publishArchive(
  run: MigrationRun,
  target: MigrationTarget,
  sourcePath: string,
  archivePath: string,
  options: {
    kind?: SessionSqliteMigrationMove["kind"];
    imported?: boolean;
    remounted?: boolean;
  } = {},
): Promise<SessionSqliteMigrationMove> {
  const { kind = "unreferenced-jsonl", imported = false, remounted = false } = options;
  const move: SessionSqliteMigrationMove = {
    kind,
    sourcePath,
    archivePath,
    artifact: {
      identity: readMigrationArtifactIdentity(sourcePath),
      classification: imported ? "imported" : "protected",
      reason: imported ? "verified-index-import" : "unreferenced-history",
      dependencies: [],
      disposal: { state: "retained" },
    },
  };
  recordPlannedMigrationMoves(run, target, [move]);
  await moveMigrationArtifact(sourcePath, archivePath, move.artifact!.identity);
  // Publish against the live device, then model the retained receipt's pre-remount identity.
  if (remounted) {
    move.artifact!.identity.dev = String(BigInt(move.artifact!.identity.dev) + 1n);
  }
  recordCompletedMigrationMoves(run, target, [move]);
  return move;
}
function completeRun(run: MigrationRun, target: MigrationTarget) {
  updateMigrationManifestTarget(run, target, [], { validationBeforeArchive: "passed" });
  run.manifest.completedAt = new Date().toISOString();
  writeSessionSqliteMigrationManifest(run);
}

function transcript(id: string, phrase: string) {
  const message = { role: "user", content: phrase };
  const rows = [
    { type: "session", id, version: 3 },
    { type: "message", id: `${id}-user`, parentId: null, message },
  ];
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

it("retains growing duplicate archives and the restore refusal without leaking its descriptor", () =>
  withOpenClawTestState({ label: "doctor-restore-growing-archive" }, async (state) => {
    const { sessions, target, archiveDir } = discoveryState(state);
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
    using reads = vi.spyOn(fs, "readSync");
    reads.mockImplementation(
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
        const options =
          typeof offsetOrOptions === "number"
            ? { offset: offsetOrOptions, length, position }
            : offsetOrOptions;
        return read(fd, buffer, options);
      },
    );
    const report = await restoreSessionSqliteMigrationRun({
      env: state.env,
      manifestPath: run.manifestPath,
      trustedTargets: [target],
    });
    reads.mockRestore();
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
    const recorded = readManifest(run.manifestPath);
    expect(recorded?.restore?.consumedArchives ?? []).not.toContain(archivePath);
    expect(recorded?.restore?.restoredFiles).toEqual([]);
  }));

it("admits transcript-only retired agents through the public selector", () =>
  withOpenClawTestState({ label: "doctor-transcript-only" }, async (state) => {
    const run = (mode: Parameters<typeof runDoctorSessionSqlite>[0]["mode"]) =>
      runDoctorSessionSqlite({ mode, agent: "retired", cfg: {}, env: state.env });
    const sessions = state.sessionsDir("retired");
    fs.mkdirSync(sessions, { recursive: true });
    const store = path.join(sessions, "sessions.json");
    const id = "77777777-7777-4777-8777-777777777777";
    const source = path.join(sessions, `${id}.jsonl`);
    const bytes = transcript(id, "retiredhistoryneedle");
    fs.writeFileSync(source, bytes);
    const sqlitePath = resolveTargetSqlitePath({ agentId: "retired", storePath: store }, state.env);
    expect(fs.existsSync(store)).toBe(false);
    expect(fs.existsSync(sqlitePath)).toBe(false);
    for (const mode of ["dry-run", "validate"] as const) {
      const report = await run(mode);
      expect(report.targets).toEqual([
        expect.objectContaining({ agentId: "retired", legacyEntries: 1 }),
      ]);
      expect(fs.existsSync(sqlitePath)).toBe(false);
      expect(fs.readFileSync(source, "utf8")).toBe(bytes);
    }
    const report = await run("import");
    expect(report.totals.importedEntries).toBe(1);
    expect(issues(report)).toEqual([]);
    closeAgentHandles();
    expect(
      searchTranscripts({ agentId: "retired", env: state.env, query: "retiredhistoryneedle" }).hits,
    ).toEqual([expect.objectContaining({ sessionId: id })]);
    const archived = report.targets.flatMap((target) => target.archivedTranscriptFiles);
    expect(archived).toHaveLength(1);
    expect(fs.readFileSync(archived[0]!, "utf8")).toBe(bytes);
    expect((await run("import")).totals.importedEntries).toBe(0);
  }));

it.each(["lineage", "generated"] as const)(
  "imports primary history without changing its logical owner (%s)",
  (variant) =>
    withOpenClawTestState({ label: "doctor-primary-history" }, async (state) => {
      const { store, run, search, writeTranscript, entry: readEntry } = discoveryState(state);
      const key = "agent:main:main";
      const id = "11111111-1111-4111-8111-111111111111";
      const query = variant === "lineage" ? "oldfamilyneedle" : "generatedcurrentneedle";
      const entry = {
        sessionId: variant === "lineage" ? "current" : id,
        updatedAt: variant === "lineage" ? 42 : 123,
        sessionFile: variant === "lineage" ? "current.jsonl" : `${id}.jsonl`,
        ...(variant === "lineage" ? { previousSessionId: id } : { label: "retained-label" }),
      };
      writeJson(store, { [key]: entry });
      writeTranscript(`2026-06-15T00-00-00-000Z_${id}.jsonl`, id, query);
      if (variant === "lineage") {
        const standalone = "22222222-2222-4222-8222-222222222222";
        writeTranscript("current.jsonl", "current", "currentword");
        writeTranscript(`${standalone}.jsonl`, standalone, "oldstandaloneneedle");
      }
      const report = await run("import");
      expect(issues(report)).toEqual([]);
      expect(search(query)).toEqual([expect.objectContaining({ sessionKey: key, sessionId: id })]);
      expect(readEntry(key)?.entry).toMatchObject(
        variant === "lineage"
          ? { sessionId: "current", updatedAt: 42 }
          : { sessionId: id, updatedAt: 123, label: "retained-label" },
      );
      if (variant === "lineage") {
        expect(search("oldstandaloneneedle")).toHaveLength(1);
      }
    }),
);

it("recovers a completed old archive once, preserves bytes, and does not resurrect user-deleted history", () =>
  withOpenClawTestState({ label: "doctor-archive-discovery" }, async (state) => {
    const { sessions, store, target, run, scope, search } = discoveryState(state);
    const id = "33333333-3333-4333-8333-333333333333";
    const original = path.join(sessions, `${id}.jsonl`);
    const bytes = transcript(id, "archivedneedle");
    fs.writeFileSync(original, bytes);
    const archive = path.join(
      path.dirname(sessions),
      "session-sqlite-import-archive",
      `archive-tier.${id}.jsonl.imported-1`,
    );
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const old = createSessionSqliteMigrationRun(state.env, [target]);
    const move = await publishArchive(old, target, original, archive);
    completeRun(old, target);
    const completed = migrationRun.recordCompletedMigrationMoves;
    using interrupted = vi
      .spyOn(migrationRun, "recordCompletedMigrationMoves")
      .mockImplementation((activeRun, owner, moves) => {
        if (
          moves.some(
            (candidateMove) => candidateMove.artifact?.reason === "indexed-historical-primary",
          )
        ) {
          throw new Error("simulated interruption before recovery receipt");
        }
        return completed(activeRun, owner, moves);
      });
    await expect(run("import")).rejects.toThrow("simulated interruption");
    interrupted.mockRestore();
    closeAgentHandles();
    const report = await run("import");
    expect(issues(report)).toEqual([]);
    expect(report.totals.importedEntries).toBe(1);
    const hit = search("archivedneedle")[0];
    expect(hit).toMatchObject({ sessionId: id });
    expect(fs.readFileSync(archive, "utf8")).toBe(bytes);
    closeAgentHandles();
    expect(search("archivedneedle")).toHaveLength(1);
    expect((await run("import")).totals.importedEntries).toBe(0);
    const key = hit!.sessionKey;
    await deleteSessionEntryLifecycle({
      ...scope,
      storePath: store,
      target: { canonicalKey: key, storeKeys: [key] },
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
    });
    expect(search("archivedneedle")).toEqual([]);
    // Keep the acknowledgment when a later unacknowledged move coalesces onto it.
    const duplicate = `${archive}.duplicate`;
    fs.copyFileSync(archive, duplicate);
    const acknowledged = {
      manifestPath: report.migrationRun!.manifestPath,
      manifest: readManifest(report.migrationRun!.manifestPath)!,
    };
    const duplicateMove: SessionSqliteMigrationMove = {
      ...move,
      archivePath: duplicate,
      artifact: { ...move.artifact!, identity: readMigrationArtifactIdentity(duplicate) },
    };
    recordPlannedMigrationMoves(acknowledged, target, [duplicateMove]);
    recordCompletedMigrationMoves(acknowledged, target, [duplicateMove]);
    const settled = await run("import");
    expect(issues(settled)).toEqual([
      expect.objectContaining({ code: "historical_duplicate_settled" }),
    ]);
    expect(settled.totals.importedEntries).toBe(0);
    expect(fs.existsSync(duplicate)).toBe(false);
    expect(readManifest(acknowledged.manifestPath)?.targets[0]?.completedMoves).toEqual([
      expect.objectContaining({
        archivePath: archive,
        artifact: expect.objectContaining({ reason: "indexed-historical-primary" }),
      }),
    ]);
    expect((await run("import")).totals.importedEntries).toBe(0);
    expect(search("archivedneedle")).toEqual([]);
    expect(fs.readFileSync(archive, "utf8")).toBe(bytes);
  }));

it("recover settles identical repeated archives across retained manifests and names differing pairs", () =>
  withOpenClawTestState({ label: "doctor-duplicate-archives" }, async (state) => {
    const { sessions, target, archiveDir, run, search } = discoveryState(state);
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
        const move = await publishArchive(old, target, sourcePath, archivePath, {
          remounted: true,
        });
        moves.push(move);
      }
      completeRun(old, target);
    }
    // Later retries retained both source claims; the latest failed run moved nothing.
    for (let attempt = 0; attempt < 3; attempt++) {
      const retry = createSessionSqliteMigrationRun(state.env, [target]);
      manifests.push(retry.manifestPath);
      recordPlannedMigrationMoves(retry, target, attempt < 2 ? moves : []);
      retry.manifest.failedAt = new Date().toISOString();
      writeSessionSqliteMigrationManifest(retry);
    }
    const dry = await run("dry-run");
    expect(dry.totals.legacyEntries).toBe(1);
    expect(
      dry.targets[0]!.issues.filter((issue) => issue.code === "historical_transcript_deferred"),
    ).toHaveLength(4);
    expect(fs.readdirSync(archiveDir)).toHaveLength(10);
    const report = await run("recover");
    expect(issues(report)).toContainEqual({
      code: "historical_duplicate_settled",
      message: expect.stringContaining("Retired 1 byte-identical duplicate archive(s)"),
    });
    const deferred = issues(report).filter(
      (issue) => issue.code === "historical_transcript_deferred",
    );
    expect(deferred).toHaveLength(4);
    for (const id of ids.slice(1)) {
      expect(
        deferred.some((issue) => issue.message.startsWith(`${id}: multiple primary files`)),
      ).toBe(true);
    }
    expect(search("duplicateneedle")).toEqual([
      expect.objectContaining({ sessionId: "identical" }),
    ]);
    const identical = moves.filter((move) => path.basename(move.sourcePath) === "identical.jsonl");
    expect(identical.filter((move) => fs.existsSync(move.archivePath))).toHaveLength(1);
    for (const [file, bytes] of originals) {
      if (!path.basename(file).startsWith("identical.")) {
        expect(fs.readFileSync(file, "utf8")).toBe(bytes);
      }
    }
    const retired = identical.find((move) => !fs.existsSync(move.archivePath))!;
    const survivor = identical.find((move) => fs.existsSync(move.archivePath))!;
    expect(fs.readFileSync(survivor.archivePath, "utf8")).toBe(originals.get(survivor.archivePath));
    for (const file of manifests) {
      const manifest = readManifest(file)!;
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
      const repeated = await run(next);
      expect(issues(repeated)).toEqual(deferred);
      expect(repeated.totals.importedEntries).toBe(0);
    }
  }));

it.each([false, true])("imports renamed primary history (archived: %s)", (archived) =>
  withOpenClawTestState({ label: "doctor-renamed-history" }, async (state) => {
    const { sessions, run, search } = discoveryState(state);
    const source = path.join(sessions, "renamed.jsonl");
    const bytes = transcript("original-id", "renamedhistoryneedle");
    fs.writeFileSync(source, bytes);
    const retained = archived ? await retainSources(state, [source]) : undefined;
    const report = await run("import");
    expect(report.totals.importedEntries).toBe(1);
    expect(issues(report)).toEqual([
      expect.objectContaining({
        code: "transcript_filename_mismatch",
        message: expect.stringContaining("original-id"),
      }),
    ]);
    expect(search("renamedhistoryneedle")).toEqual([
      expect.objectContaining({ sessionId: "original-id" }),
    ]);
    const moves = readManifest(report.migrationRun!.manifestPath)!.targets.flatMap(
      (target) => target.completedMoves,
    );
    const archive = moves.find((move) => move.sourcePath === source)!.archivePath;
    expect(fs.readFileSync(archive, "utf8")).toBe(bytes);
    if (retained) {
      expectBytes(retained);
    }
    expect((await run("import")).totals.importedEntries).toBe(0);
  }),
);

it("keeps diagnostic, deleted, and ambiguous inputs out of searchable history", () =>
  withOpenClawTestState({ label: "doctor-discovery-negative" }, async (state) => {
    const { sessions, store, run, search } = discoveryState(state);
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
      ["malformed.jsonl", '{"type":"session","id":"malformed","version":3}\ninvalid\n'],
      [`${duplicate}.jsonl`, transcript(duplicate, "ambiguousneedle")],
      ["renamed-copy.jsonl", transcript(duplicate, "secondambiguousneedle")],
    ]);
    for (const [name, bytes] of files) {
      fs.writeFileSync(path.join(sessions, name), bytes);
    }
    const archivedId = "88888888-8888-4888-8888-888888888888";
    const archivedBytes = transcript(archivedId, "distinctoriginalneedle");
    const archivedSources: string[] = [];
    for (const name of [`${archivedId}.jsonl`, `2026-06-15T00-00-00-000Z_${archivedId}.jsonl`]) {
      const sourcePath = path.join(sessions, name);
      fs.writeFileSync(sourcePath, archivedBytes);
      archivedSources.push(sourcePath);
    }
    const archived = await retainSources(state, archivedSources);
    const report = await run("import");
    expect(report.totals.importedEntries).toBe(1);
    expect(report.targets[0]!.issues.map((issue) => issue.code).toSorted()).toEqual([
      ...Array(3).fill("historical_transcript_deferred"),
      "transcript_filename_mismatch",
    ]);
    expect(report.targets[0]!.issues).toContainEqual({
      code: "historical_transcript_deferred",
      message: expect.stringContaining(
        `${archivedId}: multiple primary files claim this identity; originals retained without importing:`,
      ),
    });
    expect(search("eligibleprimaryneedle")).toHaveLength(1);
    for (const query of [
      "diagnosticneedle",
      "deletedneedle",
      "ambiguousneedle",
      "secondambiguousneedle",
      "distinctoriginalneedle",
    ]) {
      expect(search(query)).toEqual([]);
    }
    const moves = readManifest(report.migrationRun!.manifestPath)!.targets.flatMap(
      (item) => item.completedMoves,
    );
    for (const [name, bytes] of files) {
      const source = path.join(sessions, name);
      const move = moves.find((candidate) => candidate.sourcePath === source);
      expect(fs.readFileSync(move?.archivePath ?? source, "utf8")).toBe(bytes);
    }
    expectBytes(archived);
  }));

it.each(["device changed", "metadata changed"])(
  "uses a 2026.9.4 archived registry under current SQLite state: %s",
  (archiveState) =>
    withOpenClawTestState({ label: "doctor-archived-lineage" }, async (state) => {
      const { sessions, store, run, scope, search, entry } = discoveryState(state);
      const key = "agent:main:main";
      const id = "66666666-6666-4666-8666-666666666666";
      const original = path.join(sessions, `2026-06-15T00-00-00-000Z_${id}.jsonl`);
      fs.writeFileSync(original, transcript(id, "archivedfamilyneedle"));
      writeJson(store, {
        [key]: {
          sessionId: "old-current",
          updatedAt: 1,
          previousSessionId: id,
          usageFamilySessionIds: [id],
        },
      });
      // v2026.9.4 wrote manifest v3 with the same dev/ino/mtimeNs/size/sha256 identity.
      const remounted = archiveState === "device changed";
      const saved = await retainSources(state, [store, original], {
        version: "2026.9.4",
        remounted,
      });
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
      const before = entry(key);
      const preview = await run("dry-run");
      expect(preview.totals).toMatchObject({ legacyEntries: 1, issues: 0, sqliteEntries: 1 });
      if (archiveState === "metadata changed") {
        const registry = [...saved.keys()].find((file) => file.includes("legacy-store."))!;
        fs.utimesSync(registry, new Date(0), new Date(0));
        for (const mode of ["dry-run", "validate", "import", "import"] as const) {
          const report = await run(mode);
          expect(report.totals).toMatchObject({ ...noImports, issues: 1, sqliteEntries: 1 });
          const issue = report.targets[0]!.issues[0]!;
          expect(issue.code).toBe("historical_transcript_deferred");
          for (const text of [
            "no longer matches its migration receipt",
            "Historical transcript import skipped",
            "does not indicate SQLite corruption",
            "No action is needed if all expected conversations are present",
            "https://docs.openclaw.ai/cli/doctor/sqlite-maintenance#changed-archived-registry",
          ]) {
            expect(issue.message).toContain(text);
          }
          expect(issue.message).not.toContain("Error:");
          if (report.migrationRun) {
            const receipt = readManifest(report.migrationRun.manifestPath)!;
            expect(receipt.failedAt).toBeUndefined();
            expect(receipt.targets[0]).toEqual(
              expect.objectContaining({ issues: [issue], completedMoves: [] }),
            );
          }
        }
        const inspected = await run("inspect");
        expect(inspected.totals).toMatchObject({ sqliteEntries: 1, issues: 0 });
        expect(search("archivedfamilyneedle")).toEqual([]);
      } else {
        const report = await run("import");
        expect(issues(report)).toEqual([]);
        expect(search("archivedfamilyneedle")).toEqual([
          expect.objectContaining({ sessionId: id, sessionKey: key }),
        ]);
      }
      expect(entry(key)).toEqual(before);
      expectBytes(saved);
    }),
);

it.each(["restored", "bytes changed", "mtime changed", "hard linked"] as const)(
  "recovers only a verified inode-only restored registry: %s",
  (variant) =>
    withOpenClawTestState({ label: "doctor-restored-registry" }, async (state) => {
      const { sessions, store, run, scope, entry, search } = discoveryState(state);
      const key = "agent:main:main";
      const id = "99999999-9999-4999-8999-999999999999";
      const original = path.join(sessions, `${id}.jsonl`);
      fs.writeFileSync(original, transcript(id, "restoredregistryneedle"));
      writeJson(store, {
        [key]: { sessionId: "old-current", previousSessionId: id, updatedAt: 1 },
      });
      fs.utimesSync(store, 1, 1);
      const saved = await retainSources(state, [store, original], { version: "2026.9.4" });
      const registry = [...saved.keys()][0]!;
      const inventory = collectRecoveryInventory({ cfg: {}, env: state.env });
      const manifestPath = inventory.references.get(registry)![0]!.run.manifestPath;
      const receiptBefore = fs.readFileSync(manifestPath, "utf8");
      const originalIdentity = readMigrationArtifactIdentity(registry);
      const restored = `${registry}.restored`;
      fs.copyFileSync(registry, restored);
      fs.utimesSync(restored, 1, 1);
      fs.renameSync(restored, registry);
      expect(fs.statSync(registry, { bigint: true }).ino.toString()).not.toBe(originalIdentity.ino);
      if (variant === "bytes changed") {
        fs.writeFileSync(registry, saved.get(registry)!.replace("old-current", "bad-current"));
        fs.utimesSync(registry, 1, 1);
      } else if (variant === "mtime changed") {
        fs.utimesSync(registry, 2, 2);
      } else if (variant === "hard linked") {
        fs.linkSync(registry, restored);
      }
      await importSqliteSessionRows({
        ...scope,
        storePath: store,
        sessionKey: key,
        entry: { sessionId: "new-current", updatedAt: 999, label: "current-user-label" },
      });
      const currentEntry = entry(key);
      expect(issues(await run("dry-run"))).toEqual([
        expect.objectContaining({ code: "historical_transcript_deferred" }),
      ]);
      expect(fs.readFileSync(manifestPath, "utf8")).toBe(receiptBefore);
      const recovered = await run("recover");
      if (variant === "restored") {
        expect(issues(recovered)).toEqual([]);
        const recoveredReceipt = fs.readFileSync(manifestPath, "utf8");
        const manifest = readManifest(manifestPath)!;
        for (const move of [
          ...manifest.targets[0]!.plannedMoves,
          ...manifest.targets[0]!.completedMoves,
        ].filter((candidate) => candidate.kind === "legacy-store")) {
          expect(move.artifact).toEqual({
            ...inventory.references.get(registry)![0]!.move.artifact,
            identity: readMigrationArtifactIdentity(registry),
          });
        }
        expect(issues(await run("recover"))).toEqual([]);
        expect(fs.readFileSync(manifestPath, "utf8")).toBe(recoveredReceipt);
        expect(search("restoredregistryneedle")).toEqual([
          expect.objectContaining({ sessionKey: key, sessionId: id }),
        ]);
      } else {
        expect(issues(recovered)).toEqual([
          expect.objectContaining({ code: "historical_transcript_deferred" }),
        ]);
        expect(fs.readFileSync(manifestPath, "utf8")).toBe(receiptBefore);
      }
      expect(entry(key)).toEqual(currentEntry);
      expect(entry(key)?.entry).toMatchObject({
        sessionId: "new-current",
        updatedAt: 999,
        label: "current-user-label",
      });
      expect(fs.existsSync(store)).toBe(false);
      expect(fs.readFileSync(registry, "utf8")).toBe(
        variant === "bytes changed"
          ? saved.get(registry)!.replace("old-current", "bad-current")
          : saved.get(registry),
      );
    }),
);

it("preserves retained shared aliases after the old migration cleared their filenames", () =>
  withOpenClawTestState({ label: "doctor-shared-archive" }, async (state) => {
    const { sessions, store, run, search, entry: readEntry } = discoveryState(state);
    const id = "shared-session";
    const entries = {
      "agent:main:shared-a": { sessionId: id, updatedAt: 42 },
      "agent:main:shared-b": { sessionId: id, updatedAt: 43 },
    };
    writeJson(store, entries);
    for (const [sessionKey, entry] of Object.entries(entries)) {
      await importSqliteSessionRows({ agentId: "main", storePath: store, sessionKey, entry });
    }
    const sources = ["shared-a.jsonl", "shared-b.jsonl"].map((name) => path.join(sessions, name));
    for (const source of sources) {
      fs.writeFileSync(source, transcript(id, "sharedaliasneedle"));
    }
    const originals = await retainSources(state, [store, ...sources]);
    for (const mode of ["validate", "import"] as const) {
      expect((await run(mode)).totals).toMatchObject({ ...noImports, issues: 0 });
    }
    expectBytes(originals);
    for (const [sessionKey, entry] of Object.entries(entries)) {
      expect(readEntry(sessionKey)?.entry).toMatchObject(entry);
    }
    expect(search("sharedaliasneedle")).toEqual([]);
  }));
