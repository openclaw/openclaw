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
  writeSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  claimSessionSqliteMigrationGithubIssue,
  createSessionSqliteMigrationFailureIssue,
} from "./doctor-session-sqlite-failure.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  importLegacyStore,
  RECOVERY_TRANSCRIPT_LINES,
  readMigrationManifest,
  requireMigrationManifestPath,
  trustedMigrationTarget,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore, createVerifiedRecoveryStore } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it.each(
    [
      { reference: "explicit", sessionFile: "session-1.jsonl" },
      { reference: "default", sessionFile: undefined },
      { reference: "relocated", sessionFile: "/previous-machine/relocated-original.jsonl" },
      {
        reference: "canonical-relocated",
        sessionFile: "/previous-machine/.openclaw/agents/main/sessions/relocated-original.jsonl",
      },
    ].flatMap(({ reference, sessionFile }) =>
      ([1, 2, 3] as const).map((version) => ({ reference, sessionFile, version })),
    ),
  )(
    "preserves index dependencies across an interrupted import retry ($reference, v$version)",
    async ({ sessionFile, version }) => {
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
        await expect(
          runDoctorSessionSqlite({
            env: store.env,
            store: store.storePath,
            mode: "import",
          }),
        ).rejects.toThrow("interrupted after transcript publication");
      } finally {
        spy.mockRestore();
      }
      expect(readMigrationManifest(interruptedManifestPath).completedAt).toBeUndefined();
      expect(fs.existsSync(transcriptPath)).toBe(false);
      expect(fs.readFileSync(store.storePath)).toEqual(indexBytes);
      const retried = await runDoctorSessionSqlite({
        env: store.env,
        store: store.storePath,
        mode: "import",
      });
      expect(retried.targets.flatMap((target) => target.issues)).toEqual([]);
      expect(
        migrationRun.readSessionSqliteMigrationManifest(
          requireMigrationManifestPath(retried.migrationRun?.manifestPath),
        ),
      ).toBeDefined();
      if (version !== 3) {
        for (const runPath of [interruptedManifestPath, retried.migrationRun?.manifestPath]) {
          const manifestPath = requireMigrationManifestPath(runPath);
          const historical = readMigrationManifest(manifestPath);
          historical.manifestVersion = version;
          for (const target of historical.targets) {
            for (const move of [...target.plannedMoves, ...target.completedMoves]) {
              delete move.artifact;
            }
          }
          fs.writeFileSync(manifestPath, JSON.stringify(historical));
        }
      }
      closeOpenClawAgentDatabasesForTest();
      const retired = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      const manifest = readMigrationManifest(retried.migrationRun?.manifestPath);
      const indexMove = expectDefined(
        manifest.targets[0]?.completedMoves.find((move) => move.kind === "legacy-store"),
        "retry must publish the index",
      );
      expect(fs.existsSync(indexMove.archivePath)).toBe(true);
      expect(retired.totals.removedFiles).toBe(0);
      const restored = await runDoctorSessionSqlite({
        env: store.env,
        store: store.storePath,
        mode: "restore",
      });
      expect(restored.targets.flatMap((target) => target.issues)).toEqual([]);
      expect(fs.readFileSync(store.storePath)).toEqual(indexBytes);
      expect(fs.readFileSync(transcriptPath)).toEqual(transcriptBytes);
      await runDoctorSessionSqlite({ env: store.env, store: store.storePath, mode: "import" });
      closeOpenClawAgentDatabasesForTest();
      const completed = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(completed.totals.removedFiles).toBe(2);
    },
  );

  it.each(["transcript", "legacy-store"] as const)(
    "retains unique %s bytes changed at archival identity capture",
    async (kind) => {
      const { store } = await createVerifiedRecoveryStore();
      await runDoctorSessionSqlite({ env: store.env, mode: "restore", store: store.storePath });
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
      expect(fs.readFileSync(source, "utf8")).toBe(replacement);
      expect(
        imported.targets[0]?.issues.some(
          (issue) =>
            issue.code ===
            (kind === "transcript" ? "transcript_archive_failed" : "legacy_store_archive_failed"),
        ),
      ).toBe(true);
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(cleanup.artifacts.filter((item) => item.outcome === "removed")).toEqual([]);
      expect(fs.readFileSync(source, "utf8")).toBe(replacement);
      expect(
        JSON.stringify(
          loadTranscriptEventsSync({
            agentId: "main",
            storePath: store.storePath,
            sessionId: "session-1",
          }),
        ),
      ).not.toContain("never imported");
    },
  );

  it.each([1, 2] as const)(
    "retains historical v%s index and sibling history after partial adoption",
    async (version) => {
      const store = createLegacyStore({
        transcriptLines: [
          JSON.stringify({ type: "session", id: "session-1", version: 3 }),
          JSON.stringify({
            type: "message",
            id: "one",
            parentId: null,
            message: { role: "user", content: "original" },
          }),
        ],
      });
      const index = JSON.parse(fs.readFileSync(store.storePath, "utf8"));
      const siblingSource = path.join(store.sessionDir, "second.jsonl");
      index["agent:main:second"] = {
        sessionId: "second",
        updatedAt: 2000,
        sessionFile: "second.jsonl",
      };
      fs.writeFileSync(store.storePath, JSON.stringify(index));
      fs.writeFileSync(
        siblingSource,
        JSON.stringify({ type: "session", id: "second", version: 3 }) + "\n",
      );
      const imported = await importLegacyStore(store);
      expect(imported.targets[0]?.issues).toEqual([]);
      const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      const target = manifest.targets[0]!;
      const indexMove = target.plannedMoves.find((move) => move.kind === "legacy-store")!;
      const archivePath = target.plannedMoves.find(
        (move) => move.sourcePath === store.transcriptPath,
      )!.archivePath;
      const siblingArchive = target.plannedMoves.find(
        (move) => move.sourcePath === siblingSource,
      )!.archivePath;
      manifest.manifestVersion = version;
      for (const move of [...target.plannedMoves, ...target.completedMoves]) {
        delete move.artifact;
      }
      fs.appendFileSync(
        archivePath,
        JSON.stringify({ type: "future_event", id: "unknown", payload: "unique original" }) + "\n",
      );
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      closeOpenClawAgentDatabasesForTest();
      const originals = [indexMove.archivePath, archivePath, siblingArchive].map((file) => ({
        file,
        bytes: fs.readFileSync(file),
      }));
      const result = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      for (const original of originals) {
        expect(result.artifacts.find((item) => item.path === original.file)?.outcome).toBe(
          "protected",
        );
        expect(fs.readFileSync(original.file)).toEqual(original.bytes);
      }
      expect(result.totals.removedFiles).toBe(0);
    },
  );

  it.each([
    "completed restore",
    "interrupted linked restore",
    "external completed restore",
  ] as const)("preserves current session state on reimport after %s", async (restoreState) => {
    const store = createLegacyStore({
      customStore: restoreState === "external completed restore",
      transcriptLines: RECOVERY_TRANSCRIPT_LINES,
    });
    const imported = await importLegacyStore(store);
    expect(imported.targets[0]?.issues).toEqual([]);
    closeOpenClawAgentDatabasesForTest();
    const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
    expect(manifest.completedAt).toBeDefined();
    const originals = [store.storePath, store.transcriptPath].map((sourcePath) => {
      const move = expectDefined(
        manifest.targets[0]?.completedMoves.find((item) => item.sourcePath === sourcePath),
        "completed import source",
      );
      return {
        sourcePath,
        archivePath: move.archivePath,
        bytes: fs.readFileSync(move.archivePath),
      };
    });
    const scope = {
      agentId: "main",
      env: store.env,
      sessionKey: "agent:main:main",
      storePath: store.storePath,
    };
    const currentTimestamp = Date.parse("2026-08-31T00:00:00.000Z");
    const currentMetadata = {
      label: "Renamed after import",
      pinnedAt: currentTimestamp,
      lastActivityAt: currentTimestamp + 1000,
      updatedAt: currentTimestamp + 2000,
    };
    await updateSessionEntry(scope, () => currentMetadata);
    const transcriptScope = { ...scope, sessionId: "session-1" };
    const appended = await appendTranscriptMessage(transcriptScope, {
      eventId: "after-import",
      now: currentMetadata.updatedAt,
      message: { role: "user", content: "Current history after the completed import" },
    });
    expect(appended.appended).toBe(true);
    const currentEntry = structuredClone(
      expectDefined(loadSessionEntry(scope), "current session entry"),
    );
    expect(currentEntry).toMatchObject({
      label: currentMetadata.label,
      pinnedAt: currentMetadata.pinnedAt,
      lastActivityAt: currentMetadata.lastActivityAt,
    });
    const currentHistory = structuredClone(loadTranscriptEventsSync(transcriptScope));
    await closeOpenClawAgentDatabasesAsync();

    if (restoreState === "interrupted linked restore") {
      // Persist the two-name inode left by a crash before the restore receipt and unlink.
      for (const original of originals) {
        fs.linkSync(original.archivePath, original.sourcePath);
      }
      expect(readMigrationManifest(imported.migrationRun?.manifestPath).restore).toBeUndefined();
    } else {
      const restored = await runDoctorSessionSqlite({
        env: store.env,
        mode: "restore",
        store: store.storePath,
      });
      expect(restored.targets[0]?.issues).toEqual([]);
    }
    for (const original of originals) {
      expect(fs.readFileSync(original.sourcePath)).toEqual(original.bytes);
    }
    const reimported = await importLegacyStore(store);
    expect(reimported.targets[0]?.issues).toEqual([]);
    expect({
      entry: loadSessionEntry(scope),
      history: loadTranscriptEventsSync(transcriptScope),
    }).toEqual({ entry: currentEntry, history: currentHistory });
    closeOpenClawAgentDatabasesForTest();
    if (restoreState === "external completed restore") {
      // Explicit import admission does not grant cleanup ownership outside the state directory.
      return;
    }
    const result = await retireSessionSqliteRecovery({
      env: store.env,
      preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
      readConfig: async () => ({}),
      confirm: async () => true,
    });
    expect(result.status).toBe("complete");
    expect(result.totals.removedFiles).toBe(2);
    const current = readMigrationManifest(reimported.migrationRun?.manifestPath);
    for (const move of current.targets[0]!.plannedMoves.filter(
      (item) => item.kind === "transcript" || item.kind === "legacy-store",
    )) {
      expect(move.artifact?.disposal.state).toBe("disposed");
    }
  });

  it.each(["untrusted target", "unreadable manifest", "missing restore markers"] as const)(
    "refuses %s without changing current state or restored originals",
    async (receiptFailure) => {
      const { store, imported } = await createVerifiedRecoveryStore();
      const scope = {
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      };
      await updateSessionEntry(scope, () => ({ label: "Current metadata after import" }));
      const transcriptScope = { ...scope, sessionId: "session-1" };
      const current = structuredClone({
        entry: loadSessionEntry(scope),
        history: loadTranscriptEventsSync(transcriptScope),
      });
      expect(current.entry?.label).toBe("Current metadata after import");
      closeOpenClawAgentDatabasesForTest();
      const restored = await runDoctorSessionSqlite({
        env: store.env,
        mode: "restore",
        store: store.storePath,
      });
      expect(restored.targets[0]?.issues).toEqual([]);
      const originals = [store.storePath, store.transcriptPath].map((sourcePath) => ({
        sourcePath,
        bytes: fs.readFileSync(sourcePath),
      }));
      const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
      if (receiptFailure === "unreadable manifest") {
        fs.writeFileSync(manifestPath, "{");
      } else {
        const manifest = readMigrationManifest(manifestPath);
        if (receiptFailure === "missing restore markers") {
          delete manifest.restore;
        } else {
          const target = expectDefined(manifest.targets[0], "restored target");
          target.sqlitePath = path.join(store.stateDir, "unrelated.sqlite");
        }
        writeSessionSqliteMigrationManifest({ manifest, manifestPath });
      }

      await expect(importLegacyStore(store)).rejects.toThrow(
        receiptFailure === "unreadable manifest"
          ? "Session recovery history cannot be verified"
          : "Restored session index evidence cannot be verified",
      );
      expect({
        entry: loadSessionEntry(scope),
        history: loadTranscriptEventsSync(transcriptScope),
      }).toEqual(current);
      for (const original of originals) {
        expect(fs.readFileSync(original.sourcePath)).toEqual(original.bytes);
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
    fs.writeFileSync(store.storePath, JSON.stringify(index));
    const runs = path.join(store.stateDir, "session-sqlite-migration-runs");
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, "unrelated-agent.json"), "{");

    const imported = await importLegacyStore(store);
    expect(imported.totals.importedEntries).toBe(257);
    expect(imported.targets[0]?.sqliteEntries).toBe(257);
    expect(
      loadSessionEntry({
        agentId: "main",
        env: store.env,
        storePath: store.storePath,
        sessionKey: "agent:main:fresh-256",
      }),
    ).toMatchObject({ label: "Fresh 256", sessionId: "fresh-256" });
  });

  it("imports a fresh index inode normally despite a previous restore receipt", async () => {
    const { store } = await createVerifiedRecoveryStore();
    const scope = {
      agentId: "main",
      env: store.env,
      sessionKey: "agent:main:main",
      storePath: store.storePath,
    };
    await updateSessionEntry(scope, () => ({ label: "Current metadata after import" }));
    const transcriptScope = { ...scope, sessionId: "session-1" };
    const currentHistory = structuredClone(loadTranscriptEventsSync(transcriptScope));
    closeOpenClawAgentDatabasesForTest();
    const restored = await runDoctorSessionSqlite({
      env: store.env,
      mode: "restore",
      store: store.storePath,
    });
    expect(restored.targets[0]?.issues).toEqual([]);
    const retainedIndex = `${store.storePath}.restored-original`;
    fs.renameSync(store.storePath, retainedIndex);
    const freshEntry = {
      sessionId: "session-1",
      sessionFile: "session-1.jsonl",
      label: "Fresh legacy metadata",
      updatedAt: Date.parse("2026-08-31T00:00:00.000Z"),
    };
    fs.writeFileSync(store.storePath, JSON.stringify({ "agent:main:main": freshEntry }));
    expect(fs.statSync(store.storePath).ino).not.toBe(fs.statSync(retainedIndex).ino);

    const imported = await importLegacyStore(store);
    expect(imported.targets[0]?.issues).toEqual([]);
    expect(loadSessionEntry(scope)).toMatchObject({
      label: freshEntry.label,
      updatedAt: freshEntry.updatedAt,
    });
    expect(loadTranscriptEventsSync(transcriptScope)).toEqual(currentHistory);
  });

  it.each([1, 2] as const)(
    "adopts only complete historical v%s recovery evidence",
    async (version) => {
      const { store, imported, archivePath } = await createVerifiedRecoveryStore([
        JSON.stringify({ type: "session", id: "session-1", version: 1 }),
        JSON.stringify({ type: "message", message: { role: "user", content: "legacy IDs" } }),
      ]);
      const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
      const manifest = readMigrationManifest(manifestPath);
      manifest.manifestVersion = version;
      for (const target of manifest.targets) {
        for (const move of [...target.plannedMoves, ...target.completedMoves]) {
          delete move.artifact;
        }
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
      expect(preview.artifacts.find((item) => item.path === archivePath)?.outcome).toBe(
        "verification-required",
      );
      const result = await retireSessionSqliteRecovery({
        env: store.env,
        preview,
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(result.artifacts.find((item) => item.path === archivePath)?.outcome).toBe("removed");
      expect(result.artifacts.filter((item) => item.outcome === "protected")).toHaveLength(2);
    },
  );

  it("preserves a support receipt version while adopting recovery evidence", async () => {
    const { store, imported, archivePath } = await createVerifiedRecoveryStore([
      JSON.stringify({ type: "session", id: "session-1", version: 1 }),
      JSON.stringify({ type: "message", message: { role: "user", content: "legacy IDs" } }),
    ]);
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const jsonPath = manifestPath.replace(/\.json$/u, ".failure.json");
    const markdownPath = manifestPath.replace(/\.json$/u, ".failure.md");
    manifest.failureReports = { jsonPath, markdownPath };
    for (const target of manifest.targets) {
      for (const move of [...target.plannedMoves, ...target.completedMoves]) {
        delete move.artifact;
      }
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(markdownPath, "sanitized report\n", { mode: 0o600 });
    const { marker, title } = prepareGithubIssue(
      expectDefined(createSessionSqliteMigrationFailureIssue(manifestPath), "adoption report"),
    );
    const issue = { marker, title };
    expect(
      claimSessionSqliteMigrationGithubIssue(manifestPath, issue, { assertCurrent: vi.fn() }),
    ).toMatchObject({ status: "claimed" });
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
    expect(preview.artifacts.find((item) => item.path === archivePath)?.outcome).toBe(
      "verification-required",
    );

    await retireSessionSqliteRecovery({
      env: store.env,
      preview,
      readConfig: async () => ({}),
      confirm: async () => true,
    });

    expect(readMigrationManifest(manifestPath)).toMatchObject({
      failureReports: { githubIssue: { ...issue, status: "attempted" } },
      manifestVersion: 4,
    });
  });

  it("retains archived source mappings after more than 50 successful migration runs", async () => {
    const store = createLegacyStore();
    const original = fs.readFileSync(store.transcriptPath);
    const imported = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const archive = manifest.targets[0]!.completedMoves.find((move) => move.kind === "transcript")!;
    // Real run creation owns retention. Later payload-free successes must not erase rollback maps.
    for (let index = 0; index < 52; index += 1) {
      const run = createSessionSqliteMigrationRun(store.env, [trustedMigrationTarget(store)]);
      run.manifest.completedAt = new Date(Date.now() + index + 1).toISOString();
      writeSessionSqliteMigrationManifest(run);
    }
    expect(fs.readFileSync(archive.archivePath)).toEqual(original);
    const restored = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });
    expect(restored.targets[0]?.restore?.manifestPaths).toContain(manifestPath);
    expect(fs.readFileSync(store.transcriptPath)).toEqual(original);
  });
});
