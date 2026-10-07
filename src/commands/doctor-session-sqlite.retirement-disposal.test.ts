import fs from "node:fs";
import path from "node:path";
import * as replaceFile from "@openclaw/fs-safe/atomic";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { readSessionTranscriptHistoryEventPage } from "../config/sessions/session-accessor.sqlite-history-events.js";
import {
  readSessionTranscriptHistoryEvents,
  readSessionTranscriptHistoryEventCount,
  readSessionTranscriptHistoryEventById,
} from "../config/sessions/session-accessor.sqlite-history.test-support.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  createSessionSqliteMigrationRun,
  writeSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import * as sqliteReaders from "../infra/session-sqlite-migration-readers.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { runOutsideOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  isDirectoryDescriptor,
  importLegacyStore,
  readMigrationManifest,
  requireMigrationManifestPath,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

vi.mock("@openclaw/fs-safe/atomic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/atomic")>()),
}));

const { createLegacyStore, createVerifiedRecoveryStore } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it.each([
    "intent",
    "intent-sync",
    "claim",
    "unlink",
    "unlink-later",
    "recreated",
    "shared-receipt",
  ])("resumes retirement after a %s failure without overclaiming removed bytes", async (phase) => {
    const { store, imported, archivePath } = await createVerifiedRecoveryStore();
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const manifestDir = path.dirname(manifestPath);
    const duplicate =
      phase === "shared-receipt" ? createSessionSqliteMigrationRun(store.env, []) : undefined;
    if (duplicate) {
      const manifest = readMigrationManifest(manifestPath);
      duplicate.manifest.targets = structuredClone(manifest.targets);
      duplicate.manifest.completedAt = manifest.completedAt;
      writeSessionSqliteMigrationManifest(duplicate);
    }
    const original = fs.readFileSync(archivePath);
    let injected = false;
    let claimUnlinks = 0;
    const write = replaceFile.replaceFileAtomicSync;
    const unlink = fs.unlinkSync;
    const fsync = fs.fsyncSync;
    const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (!injected && phase === "intent-sync" && isDirectoryDescriptor(fd, manifestDir)) {
        injected = true;
        throw new Error("injected intent-sync");
      }
      fsync(fd);
    });
    const writeSpy = vi
      .spyOn(replaceFile, "replaceFileAtomicSync")
      .mockImplementation((options) => {
        const text = String(options.content);
        const shouldFail =
          phase === "intent"
            ? text.includes('"pending-disposal"')
            : duplicate && options.filePath === manifestPath && text.includes('"disposed"');
        if (!injected && shouldFail) {
          injected = true;
          if (duplicate) {
            expect(
              readMigrationManifest(duplicate.manifestPath).targets[0]?.plannedMoves.find(
                (move) => move.archivePath === archivePath,
              )?.artifact?.disposal.state,
            ).toBe("disposed");
          }
          throw new Error(`injected ${phase}`);
        }
        return write(options);
      });
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (String(file).includes(".cleanup-")) {
        claimUnlinks += 1;
      }
      if (
        !injected &&
        (((phase === "unlink" || phase === "recreated") && String(file).includes(".cleanup-")) ||
          (phase === "unlink-later" && claimUnlinks === 2) ||
          (phase === "claim" && String(file) === archivePath))
      ) {
        injected = true;
        throw new Error(`injected ${phase}`);
      }
      return unlink(file);
    });
    const invoke = () =>
      retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
    try {
      if (phase === "intent" || phase === "intent-sync") {
        await expect(invoke()).rejects.toThrow(`injected ${phase}`);
        expect(fs.readFileSync(archivePath)).toEqual(original);
      } else {
        const first = await invoke();
        expect(first.status).toBe("blocked");
        if (phase === "unlink-later") {
          expect(first.totals.removedFiles).toBe(1);
        }
        if (duplicate) {
          expect(first.artifacts.find((item) => item.path === archivePath)?.removedBytes).toBe(
            original.length,
          );
        }
      }
    } finally {
      writeSpy.mockRestore();
      unlinkSpy.mockRestore();
      syncSpy.mockRestore();
    }
    expect(injected).toBe(true);
    if (phase === "recreated") {
      fs.writeFileSync(archivePath, "replacement after interrupted cleanup");
    }
    const resumed = await invoke();
    if (phase === "recreated") {
      expect(resumed.status).toBe("blocked");
      expect(fs.readFileSync(archivePath, "utf8")).toBe("replacement after interrupted cleanup");
      expect(
        resumed.artifacts.find((item) => item.path === archivePath)?.removedBytes,
      ).toBeUndefined();
      return;
    }
    expect(resumed.status).toBe("complete");
    if (duplicate) {
      for (const file of [manifestPath, duplicate.manifestPath]) {
        expect(
          readMigrationManifest(file).targets[0]!.plannedMoves.find(
            (move) => move.archivePath === archivePath,
          )?.artifact?.disposal.state,
        ).toBe("disposed");
      }
    }
    expect(fs.existsSync(archivePath)).toBe(false);
    if (duplicate) {
      expect(resumed.totals.removedBytes).toBe(0);
    }
  });

  it("refuses retirement while a peer maintenance operation holds the selected state", async () => {
    const { store, archivePath } = await createVerifiedRecoveryStore();
    const original = fs.readFileSync(archivePath);
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
    const confirm = vi.fn(async () => true);
    await withDoctorSqliteMaintenanceLock({
      env: store.env,
      operation: "fixture import",
      run: async () => {
        await expect(
          runOutsideOpenClawDatabaseMaintenanceScope(() =>
            retireSessionSqliteRecovery({
              env: store.env,
              preview,
              readConfig: async () => ({}),
              confirm,
            }),
          ),
        ).rejects.toThrow("undergoing offline maintenance");
      },
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(fs.readFileSync(archivePath)).toEqual(original);
  });

  it("protects duplicate divergent ID and its recovery index", async () => {
    const store = createLegacyStore({
      transcriptLines: [
        { type: "session", id: "session-1", version: 3 },
        {
          type: "message",
          id: "duplicate",
          parentId: null,
          message: { role: "user", content: "first" },
        },
        {
          type: "message",
          id: "duplicate",
          parentId: null,
          message: { role: "user", content: "unique second" },
        },
      ].map((row) => JSON.stringify(row)),
    });
    const original = fs.readFileSync(store.transcriptPath);
    const imported = await importLegacyStore(store);
    expect(
      readMigrationManifest(imported.migrationRun?.manifestPath).targets[0]!.completedMoves.find(
        (item) => item.kind === "transcript",
      ),
    ).toBeUndefined();
    expect(imported.targets[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "sqlite_transcript_count_mismatch" }),
      ]),
    );
    closeOpenClawAgentDatabasesForTest();
    const result = await retireSessionSqliteRecovery({
      env: store.env,
      preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
      readConfig: async () => ({}),
      confirm: async () => true,
    });
    expect(result.totals.removedFiles).toBe(0);
    expect(fs.readFileSync(store.transcriptPath)).toEqual(original);
  });

  it("retains complete recovery when durable transcript verification is short", async () => {
    const store = createLegacyStore({
      transcriptLines: [
        JSON.stringify({ type: "session", id: "session-1", version: 3 }),
        JSON.stringify({
          type: "message",
          id: "root",
          parentId: null,
          message: { role: "user", content: "root" },
        }),
      ],
    });
    const snapshot = sqliteReaders.readOnlySqliteValidationSnapshot;
    const spy = vi
      .spyOn(sqliteReaders, "readOnlySqliteValidationSnapshot")
      .mockImplementation((target) => {
        const result = snapshot(target);
        if (!result.ok) {
          return result;
        }
        const counts = new Map(result.snapshot.transcriptEventCountsBySessionId);
        counts.set("session-1", 1);
        return {
          ok: true,
          snapshot: { ...result.snapshot, transcriptEventCountsBySessionId: counts },
        };
      });
    let imported;
    try {
      imported = await importLegacyStore(store);
    } finally {
      spy.mockRestore();
    }

    expect(imported.targets[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "sqlite_transcript_count_mismatch" }),
      ]),
    );
    expect(fs.existsSync(store.transcriptPath)).toBe(true);
    expect(
      readMigrationManifest(imported.migrationRun?.manifestPath).targets[0]?.completedMoves.some(
        (item) => item.kind === "transcript",
      ),
    ).toBe(false);
  });

  it("verifies duplicate replay history against a fresh destination", async () => {
    const reply = {
      type: "message",
      id: "reply",
      parentId: "root",
      message: { role: "assistant", content: "same replay" },
    };
    const leaf = { type: "leaf", id: "selection", parentId: "reply", targetId: "reply" };
    const store = createLegacyStore({
      transcriptLines: [
        { type: "session", id: "session-1", version: 3 },
        { type: "message", id: "root", parentId: null, message: { role: "user", content: "root" } },
        reply,
        reply,
        leaf,
        leaf,
      ].map((event) => JSON.stringify(event)),
    });
    const scope = { agentId: "main", env: store.env, sessionId: "session-1" };
    const imported = await importLegacyStore(store);
    expect(fs.existsSync(store.transcriptPath)).toBe(false);
    expect(
      readMigrationManifest(imported.migrationRun?.manifestPath).targets[0]?.completedMoves.some(
        (item) => item.kind === "transcript",
      ),
    ).toBe(true);
    expect(
      imported.targets[0]?.issues.some(
        (issue) => issue.code === "sqlite_transcript_count_mismatch",
      ),
    ).toBe(false);
    expect(loadTranscriptEventsSync(scope).map((event) => (event as { id?: string }).id)).toEqual([
      "session-1",
      "root",
      "reply",
      "selection",
    ]);
    expect(imported.targets[0]?.issues).toEqual([]);
    expect(
      readSessionTranscriptHistoryEvents(scope).map((row) => (row.event as { id?: string }).id),
    ).toEqual(["root", "reply"]);
    expect(readSessionTranscriptHistoryEventCount(scope)).toBe(2);
    expect(
      readSessionTranscriptHistoryEventPage(scope, { maxMessages: 1, offset: 0 }),
    ).toMatchObject({
      activeLeafEntryId: "reply",
      totalMessages: 2,
      events: [expect.objectContaining({ event: expect.objectContaining({ id: "reply" }) })],
    });
    expect(readSessionTranscriptHistoryEventById(scope, "reply")).toMatchObject({
      event: expect.objectContaining({ id: "reply" }),
    });
  });

  it("retires verified originals after remount while preserving current SQLite and unknown archives", async () => {
    const store = createLegacyStore({
      transcriptLines: [
        JSON.stringify({ type: "session", id: "session-1", version: 3 }),
        JSON.stringify({
          type: "message",
          id: "original-only",
          parentId: null,
          message: {
            role: "user",
            content:
              "hello\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nretired context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          },
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "message",
          id: "reply-1",
          parentId: "user-1",
          message: { role: "assistant", provider: "openai-codex", content: "hello back" },
        }),
      ],
    });
    const original = fs.readFileSync(store.transcriptPath);
    const imported = await importLegacyStore(store);
    expect(imported.targets[0]?.issues).toEqual([]);
    const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
    for (const target of manifest.targets) {
      for (const move of [...target.plannedMoves, ...target.completedMoves]) {
        if (move.artifact) {
          move.artifact.identity.dev = String(BigInt(move.artifact.identity.dev) + 1n);
        }
      }
    }
    writeSessionSqliteMigrationManifest({
      manifest,
      manifestPath: imported.migrationRun!.manifestPath,
    });
    const originalMove = manifest.targets[0]!.completedMoves.find(
      (move) => move.kind === "transcript",
    )!;
    expect(fs.readFileSync(originalMove.archivePath)).toEqual(original);
    expect(originalMove.artifact?.classification).toBe("repair-original");
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        storePath: store.storePath,
        sessionId: "session-1",
      }),
    ).toEqual(["session-1", "user-1", "reply-1"].map((id) => expect.objectContaining({ id })));
    const manager = SessionManager.open(
      {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      store.tempDir,
    );
    manager.appendMessage({
      role: "user",
      content: "history written after the upgrade",
      timestamp: Date.now(),
    });
    closeOpenClawAgentDatabasesForTest();
    const sqlitePath = imported.targets[0]!.sqlitePath;
    const databaseBefore = fs.readFileSync(sqlitePath);
    expect(fs.existsSync(`${sqlitePath}-wal`)).toBe(false);
    expect(fs.existsSync(`${sqlitePath}-shm`)).toBe(false);
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
    expect(preview.artifacts.find((item) => item.path === originalMove.archivePath)?.outcome).toBe(
      "candidate",
    );
    const cleanup = await retireSessionSqliteRecovery({
      env: store.env,
      preview,
      readConfig: async () => ({}),
      confirm: async () => {
        // The actual read-only owner inspection creates these sidecars before confirmation.
        expect(fs.existsSync(`${sqlitePath}-wal`)).toBe(true);
        expect(fs.existsSync(`${sqlitePath}-shm`)).toBe(true);
        return true;
      },
    });
    expect(cleanup.status).toBe("complete");
    expect(cleanup.totals.removedFiles).toBe(2);
    expect(cleanup.totals.removedBytes).toBeGreaterThan(original.length);
    expect(fs.existsSync(originalMove.archivePath)).toBe(false);
    expect(fs.readFileSync(sqlitePath)).toEqual(databaseBefore);
    expect(cleanup.artifacts.filter((item) => item.outcome === "protected")).toHaveLength(2);
    const retry = await retireSessionSqliteRecovery({
      env: store.env,
      preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
      readConfig: async () => ({}),
      confirm: async () => true,
    });
    expect(retry.totals.removedBytes).toBe(0);
    const restored = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {},
      env: store.env,
      mode: "restore",
    });
    expect(
      restored.targets[0]?.restore?.conflicts.some((item) =>
        item.reason.includes("intentionally disposed"),
      ),
    ).toBe(true);
  });
});
