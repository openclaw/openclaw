import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { updateSessionEntry } from "../config/sessions/session-accessor.entry-mutation.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { prepareGithubIssue } from "../infra/github-issue.js";
import * as migrationArtifact from "../infra/session-sqlite-migration-artifact.js";
import * as migrationRun from "../infra/session-sqlite-migration-manifest.js";
import {
  createSessionSqliteMigrationRun,
  readSessionSqliteMigrationManifest as readValidatedManifest,
  writeSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  closeOpenClawAgentDatabasesAsync as drainDatabases,
  closeOpenClawAgentDatabasesForTest as closeDatabases,
} from "../state/openclaw-agent-db.js";
import {
  claimSessionSqliteMigrationGithubIssue,
  createSessionSqliteMigrationFailureIssue,
} from "./doctor-session-sqlite-failure.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import {
  retireRecovery,
  runStoreDoctor,
  sessionScope as scopeFor,
  writeJson,
} from "./doctor-session-sqlite.fixtures.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  containsObjects,
  expectFiles,
  snapshotFiles,
} from "./doctor-session-sqlite.publication-spies.test-support.js";
import {
  importLegacyStore,
  RECOVERY_TRANSCRIPT_LINES,
  readMigrationManifest as readManifest,
  requireMigrationManifestPath as requireManifest,
  trustedMigrationTarget,
  type TestStore,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore, createVerifiedRecoveryStore } = useDoctorSessionSqliteTestFixture();

function historyFor(store: TestStore, sessionKey?: string) {
  return loadTranscriptEventsSync({ ...scopeFor(store), sessionKey });
}

function restoreStore(store: TestStore) {
  return runStoreDoctor(store, "restore");
}

async function cleanReport(pending: ReturnType<typeof importLegacyStore>) {
  const report = await pending;
  expect(report.targets.flatMap((target) => target.issues)).toEqual([]);
  return report;
}

function stateFor(store: TestStore) {
  const scope = scopeFor(store);
  return {
    entry: loadSessionEntry(scope),
    history: loadTranscriptEventsSync(scope),
  };
}

function sourceCopies(store: TestStore, manifest: ReturnType<typeof readManifest>) {
  return [store.storePath, store.transcriptPath].map((sourcePath) => {
    const archivePath = expectDefined(
      manifest.targets[0]?.completedMoves.find((move) => move.sourcePath === sourcePath),
      "completed import source",
    ).archivePath;
    return { sourcePath, archivePath, bytes: fs.readFileSync(archivePath) };
  });
}

function expectCopies(copies: { sourcePath: string; bytes: Buffer }[]) {
  for (const { sourcePath, bytes } of copies) {
    expectFiles(bytes, sourcePath);
  }
}

function rewriteHistoricalManifest(manifestPath: string, version?: 1 | 2 | 3 | 4) {
  const manifest = readManifest(manifestPath);
  if (version !== undefined) {
    manifest.manifestVersion = version;
  }
  for (const target of manifest.targets) {
    for (const move of [...target.plannedMoves, ...target.completedMoves]) {
      delete move.artifact;
    }
  }
  return manifest;
}

describe("runDoctorSessionSqlite", () => {
  it.each([
    ["session-1.jsonl", 3],
    ["session-1.jsonl", 1],
    [undefined, 2],
    ["/previous-machine/relocated-original.jsonl", 2],
    ["/previous-machine/.openclaw/agents/main/sessions/relocated-original.jsonl", 2],
  ] as const)(
    "preserves interrupted-import dependencies (%s, v%s)",
    async (sessionFile, version) => {
      const store = createLegacyStore({
        entryOverrides: { sessionFile },
        transcriptLines: [
          '{"type":"session","id":"session-1","version":3}',
          '{"type":"message","id":"one","parentId":null,"message":{"role":"user","content":"retained retry history"}}',
        ],
      });
      const transcriptPath = path.join(
        store.sessionDir,
        path.basename(sessionFile ?? store.transcriptPath),
      );
      if (transcriptPath !== store.transcriptPath) {
        fs.renameSync(store.transcriptPath, transcriptPath);
      }
      const indexBytes = fs.readFileSync(store.storePath);
      const transcriptBytes = fs.readFileSync(transcriptPath);
      let interruptedManifestPath: string | undefined;
      const spy = vi
        .spyOn(migrationRun, "recordCompletedMigrationMoves")
        .mockImplementationOnce((run) => {
          interruptedManifestPath = run?.manifestPath;
          throw new Error("interrupted after transcript publication");
        });
      try {
        await expect(importLegacyStore(store)).rejects.toThrow(
          "interrupted after transcript publication",
        );
      } finally {
        spy.mockRestore();
      }
      expect(readManifest(interruptedManifestPath).completedAt).toBeUndefined();
      expect(fs.existsSync(transcriptPath)).toBe(false);
      expectFiles(indexBytes, store.storePath);
      const retried = await cleanReport(importLegacyStore(store));
      expect(
        readValidatedManifest(requireManifest(retried.migrationRun?.manifestPath)),
      ).toBeDefined();
      if (version !== 3) {
        for (const runPath of [interruptedManifestPath, retried.migrationRun?.manifestPath]) {
          const manifestPath = requireManifest(runPath);
          writeJson(manifestPath, rewriteHistoricalManifest(manifestPath, version));
        }
      }
      closeDatabases();
      const retired = await retireRecovery(store);
      const manifest = readManifest(retried.migrationRun?.manifestPath);
      const indexMove = expectDefined(
        manifest.targets[0]?.completedMoves.find((move) => move.kind === "legacy-store"),
        "retry must publish the index",
      );
      expect(fs.existsSync(indexMove.archivePath)).toBe(true);
      expect(retired.totals.removedFiles).toBe(0);
      await cleanReport(restoreStore(store));
      expectFiles(indexBytes, store.storePath);
      expectFiles(transcriptBytes, transcriptPath);
      await importLegacyStore(store);
      closeDatabases();
      const completed = await retireRecovery(store);
      expect(completed.totals.removedFiles).toBe(2);
    },
  );

  it.each(["transcript", "legacy-store"] as const)(
    "retains unique %s bytes changed at archival identity capture",
    async (kind) => {
      const { store } = await createVerifiedRecoveryStore();
      await restoreStore(store);
      const source = kind === "transcript" ? store.transcriptPath : store.storePath;
      const replacement =
        kind === "transcript"
          ? fs.readFileSync(source, "utf8") +
            JSON.stringify({
              type: "custom",
              id: "unique",
              customType: "late",
              data: "never imported",
            }) +
            "\n"
          : JSON.stringify({ "agent:main:unique": { sessionId: "unique", updatedAt: 9000 } });
      const readIdentity = migrationArtifact.readMigrationArtifactIdentity;
      let injected = false;
      const spy = vi
        .spyOn(migrationArtifact, "readMigrationArtifactIdentity")
        .mockImplementation((file, ...args) => {
          if (
            file === source &&
            !injected &&
            (kind === "transcript" || !fs.existsSync(store.transcriptPath))
          ) {
            // Replace the index after transcript publication, at its archival identity check.
            // Earlier import validation may also read its identity.
            if (kind === "legacy-store") {
              const identity = readIdentity(file, ...args);
              fs.writeFileSync(file, replacement);
              injected = true;
              return identity;
            }
            fs.unlinkSync(file);
            fs.writeFileSync(file, replacement);
            injected = true;
          }
          return readIdentity(file, ...args);
        });
      let imported;
      try {
        imported = await importLegacyStore(store);
      } finally {
        spy.mockRestore();
      }
      expect(injected).toBe(true);
      expect(fs.existsSync(source)).toBe(true);
      expectFiles(replacement, source);
      expect(
        imported.targets[0]?.issues.some(
          (issue) =>
            issue.code ===
            (kind === "transcript" ? "transcript_archive_failed" : "legacy_store_archive_failed"),
        ),
      ).toBe(true);
      closeDatabases();
      const cleanup = await retireRecovery(store);
      expect(cleanup.artifacts.filter((item) => item.outcome === "removed")).toEqual([]);
      expectFiles(replacement, source);
      expect(JSON.stringify(historyFor(store))).not.toContain("never imported");
    },
  );

  it("retains historical v2 index and sibling history after partial adoption", async () => {
    const store = createLegacyStore({
      transcriptLines: [
        '{"type":"session","id":"session-1","version":3}',
        '{"type":"message","id":"one","parentId":null,"message":{"role":"user","content":"original"}}',
      ],
    });
    const index = JSON.parse(fs.readFileSync(store.storePath, "utf8"));
    const siblingSource = path.join(store.sessionDir, "second.jsonl");
    index["agent:main:second"] = {
      sessionId: "second",
      updatedAt: 2000,
      sessionFile: "second.jsonl",
    };
    writeJson(store.storePath, index);
    fs.writeFileSync(siblingSource, '{"type":"session","id":"second","version":3}\n');
    const imported = await cleanReport(importLegacyStore(store));
    const manifestPath = requireManifest(imported.migrationRun?.manifestPath);
    const manifest = rewriteHistoricalManifest(manifestPath, 2);
    const target = manifest.targets[0]!;
    const indexMove = target.plannedMoves.find((move) => move.kind === "legacy-store")!;
    const archivePath = target.plannedMoves.find(
      (move) => move.sourcePath === store.transcriptPath,
    )!.archivePath;
    const siblingArchive = target.plannedMoves.find(
      (move) => move.sourcePath === siblingSource,
    )!.archivePath;
    fs.appendFileSync(
      archivePath,
      JSON.stringify({ type: "future_event", id: "unknown", payload: "unique original" }) + "\n",
    );
    writeJson(manifestPath, manifest);
    closeDatabases();
    const originals = snapshotFiles([indexMove.archivePath, archivePath, siblingArchive]);
    const result = await retireRecovery(store);
    for (const original of originals) {
      expect(result.artifacts.find((item) => item.path === original.file)?.outcome).toBe(
        "protected",
      );
      expectFiles(original.bytes, original.file);
    }
    expect(result.totals.removedFiles).toBe(0);
  });

  it.each([
    "completed restore",
    "interrupted linked restore",
    "external completed restore",
    "fresh index",
  ] as const)(
    "reimports restored history without replaying current state (%s)",
    async (restoreState) => {
      const store = createLegacyStore({
        customStore: restoreState === "external completed restore",
        transcriptLines: RECOVERY_TRANSCRIPT_LINES,
      });
      const imported = await cleanReport(importLegacyStore(store));
      if (restoreState === "external completed restore") {
        const sqlitePath = expectDefined(imported.targets[0]?.sqlitePath, "custom SQLite path");
        expect(sqlitePath).toBe(path.join(store.sessionDir, "openclaw-agent.sqlite"));
        expect(fs.existsSync(sqlitePath)).toBe(true);
        expect(historyFor(store, "agent:main:main")).toHaveLength(2);
      }
      closeDatabases();
      const manifest = readManifest(imported.migrationRun?.manifestPath);
      expect(manifest.completedAt).toBeDefined();
      const originals = sourceCopies(store, manifest);
      const scope = scopeFor(store);
      const currentTimestamp = Date.parse("2026-08-31T00:00:00.000Z");
      const currentMetadata = {
        label: "Renamed after import",
        pinnedAt: currentTimestamp,
        lastActivityAt: currentTimestamp + 1000,
        updatedAt: currentTimestamp + 2000,
      };
      await updateSessionEntry(scope, () => currentMetadata);
      const appended = await appendTranscriptMessage(
        { ...scope, sessionId: "session-1" },
        {
          eventId: "after-import",
          now: currentMetadata.updatedAt,
          message: { role: "user", content: "Current history after the completed import" },
        },
      );
      expect(appended.appended).toBe(true);
      const current = structuredClone(stateFor(store));
      expect(current.entry).toMatchObject({
        label: currentMetadata.label,
        pinnedAt: currentMetadata.pinnedAt,
        lastActivityAt: currentMetadata.lastActivityAt,
      });
      await drainDatabases();

      if (restoreState === "interrupted linked restore") {
        // Persist the two-name inode left by a crash before the restore receipt and unlink.
        for (const original of originals) {
          fs.linkSync(original.archivePath, original.sourcePath);
        }
        expect(readManifest(imported.migrationRun?.manifestPath).restore).toBeUndefined();
      } else {
        await cleanReport(restoreStore(store));
      }
      expectCopies(originals);
      const freshEntry = {
        sessionId: "session-1",
        sessionFile: "session-1.jsonl",
        label: "Fresh legacy metadata",
        updatedAt: currentTimestamp,
      };
      if (restoreState === "fresh index") {
        const retainedIndex = `${store.storePath}.restored-original`;
        fs.renameSync(store.storePath, retainedIndex);
        writeJson(store.storePath, { "agent:main:main": freshEntry });
        expect(fs.statSync(store.storePath).ino).not.toBe(fs.statSync(retainedIndex).ino);
      }
      const reimported = await cleanReport(importLegacyStore(store));
      if (restoreState === "fresh index") {
        expect(loadSessionEntry(scope)).toMatchObject({
          label: freshEntry.label,
          updatedAt: freshEntry.updatedAt,
        });
        expect(stateFor(store).history).toEqual(current.history);
        return;
      }
      expect(stateFor(store)).toEqual(current);
      closeDatabases();
      if (restoreState === "external completed restore") {
        // Explicit import admission does not grant cleanup ownership outside the state directory.
        return;
      }
      const result = await retireRecovery(store);
      expect(result.status).toBe("complete");
      expect(result.totals.removedFiles).toBe(2);
      const receipt = readManifest(reimported.migrationRun?.manifestPath);
      for (const move of receipt.targets[0]!.plannedMoves.filter(
        (item) => item.kind === "transcript" || item.kind === "legacy-store",
      )) {
        expect(move.artifact?.disposal.state).toBe("disposed");
      }
    },
  );

  it.each(["untrusted target", "unreadable manifest", "missing restore markers"] as const)(
    "reconciles %s without replaying current state or losing restored originals",
    async (receiptFailure) => {
      const { store, imported } = await createVerifiedRecoveryStore();
      const scope = scopeFor(store);
      await updateSessionEntry(scope, () => ({ label: "Current metadata after import" }));
      const current = structuredClone(stateFor(store));
      expect(current.entry?.label).toBe("Current metadata after import");
      await drainDatabases();
      closeDatabases();
      await cleanReport(restoreStore(store));
      const originals = [store.storePath, store.transcriptPath].map((sourcePath) => ({
        sourcePath,
        bytes: fs.readFileSync(sourcePath),
      }));
      const manifestPath = requireManifest(imported.migrationRun?.manifestPath);
      if (receiptFailure === "unreadable manifest") {
        fs.writeFileSync(manifestPath, "{");
      } else {
        const manifest = readManifest(manifestPath);
        if (receiptFailure === "missing restore markers") {
          delete manifest.restore;
        } else {
          const target = expectDefined(manifest.targets[0], "restored target");
          target.sqlitePath = path.join(store.stateDir, "unrelated.sqlite");
        }
        writeSessionSqliteMigrationManifest({ manifest, manifestPath });
      }

      const reconciled = await importLegacyStore(store);
      const manifest = readManifest(reconciled.migrationRun?.manifestPath);
      if (receiptFailure === "unreadable manifest") {
        expect(reconciled.targets[0]?.issues).toEqual([]);
      } else {
        containsObjects(reconciled.targets[0]?.issues, {
          code: "legacy_import_deferred",
          message: expect.stringContaining("Restored session index evidence cannot be verified"),
        });
      }
      expect(stateFor(store)).toEqual(current);
      for (const original of originals) {
        const archived = manifest.targets[0]?.completedMoves.find(
          (move) => move.sourcePath === original.sourcePath,
        );
        expectFiles(original.bytes, archived?.archivePath ?? original.sourcePath);
      }
    },
  );

  it("imports more than one normal batch into fresh state despite unrelated unreadable history", async () => {
    const store = createLegacyStore({ transcriptLines: RECOVERY_TRANSCRIPT_LINES });
    const index = JSON.parse(fs.readFileSync(store.storePath, "utf8"));
    for (let number = 1; number <= 256; number++) {
      const sessionId = `fresh-${number}`;
      index[`agent:main:${sessionId}`] = {
        sessionId,
        sessionFile: `${sessionId}.jsonl`,
        updatedAt: number,
        label: `Fresh ${number}`,
      };
      fs.writeFileSync(
        path.join(store.sessionDir, `${sessionId}.jsonl`),
        `${JSON.stringify({ type: "session", id: sessionId, version: 3 })}\n`,
      );
    }
    writeJson(store.storePath, index);
    const runs = path.join(store.stateDir, "session-sqlite-migration-runs");
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, "unrelated-agent.json"), "{");

    const imported = await importLegacyStore(store);
    expect(imported.totals.importedEntries).toBe(257);
    expect(imported.targets[0]?.sqliteEntries).toBe(257);
    expect(
      loadSessionEntry({ ...scopeFor(store), sessionKey: "agent:main:fresh-256" }),
    ).toMatchObject({ label: "Fresh 256", sessionId: "fresh-256" });
  });

  it.each([1, 4] as const)(
    "adopts complete historical recovery evidence while preserving v%s receipts",
    async (version) => {
      const snapshots = {
        sessionDiffBaseline: { version: 1, sessionId: "session-1", root: "/synthetic", files: [] },
        skillsSnapshot: { prompt: "Retained skill instructions", skills: [] },
        systemPromptReport: {
          source: "run",
          generatedAt: 1000,
          sessionId: "session-1",
          systemPrompt: { chars: 40, projectContextChars: 0, nonProjectContextChars: 40 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 27, entries: [] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        },
      };
      const store = createLegacyStore({
        entryOverrides: snapshots,
        transcriptLines: [
          JSON.stringify({ type: "session", id: "session-1", version: 1 }),
          JSON.stringify({ type: "message", message: { role: "user", content: "legacy IDs" } }),
        ],
      });
      const imported = await cleanReport(importLegacyStore(store));
      expect(loadSessionEntry(scopeFor(store))).toMatchObject(snapshots);
      const manifestPath = requireManifest(imported.migrationRun?.manifestPath);
      const manifest = rewriteHistoricalManifest(manifestPath, version === 1 ? 1 : undefined);
      const archivePath = manifest.targets[0]!.completedMoves.find(
        (move) => move.kind === "transcript",
      )!.archivePath;
      closeDatabases();
      const markdownPath = manifestPath.replace(/\.json$/u, ".failure.md");
      if (version === 4) {
        manifest.failureReports = {
          jsonPath: manifestPath.replace(/\.json$/u, ".failure.json"),
          markdownPath,
        };
      }
      writeJson(manifestPath, manifest);
      let issue: { marker: string; title: string } | undefined;
      if (version === 4) {
        fs.writeFileSync(markdownPath, "sanitized report\n", { mode: 0o600 });
        const { marker, title } = prepareGithubIssue(
          expectDefined(createSessionSqliteMigrationFailureIssue(manifestPath), "adoption report"),
        );
        issue = { marker, title };
        expect(
          claimSessionSqliteMigrationGithubIssue(manifestPath, issue, { assertCurrent: vi.fn() }),
        ).toMatchObject({ status: "claimed" });
      }
      const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
      expect(preview.artifacts.find((item) => item.path === archivePath)?.outcome).toBe(
        "verification-required",
      );
      const result = await retireRecovery(store, undefined, preview);
      expect(result.artifacts.find((item) => item.path === archivePath)?.outcome).toBe("removed");
      expect(result.artifacts.filter((item) => item.outcome === "protected")).toHaveLength(2);
      if (issue) {
        expect(readManifest(manifestPath)).toMatchObject({
          failureReports: { githubIssue: { ...issue, status: "attempted" } },
          manifestVersion: 4,
        });
      }
    },
  );

  it("retains archived source mappings after more than 50 successful migration runs", async () => {
    const store = createLegacyStore();
    const original = fs.readFileSync(store.transcriptPath);
    const imported = await importLegacyStore(store);
    const manifestPath = requireManifest(imported.migrationRun?.manifestPath);
    const manifest = readManifest(manifestPath);
    const archive = manifest.targets[0]!.completedMoves.find((move) => move.kind === "transcript")!;
    // Real run creation owns retention. Later payload-free successes must not erase rollback maps.
    for (let index = 0; index < 52; index += 1) {
      const run = createSessionSqliteMigrationRun(store.env, [trustedMigrationTarget(store)]);
      run.manifest.completedAt = new Date(Date.now() + index + 1).toISOString();
      writeSessionSqliteMigrationManifest(run);
    }
    expectFiles(original, archive.archivePath);
    const restored = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });
    expect(restored.targets[0]?.restore?.manifestPaths).toContain(manifestPath);
    expectFiles(original, store.transcriptPath);
  });
});
