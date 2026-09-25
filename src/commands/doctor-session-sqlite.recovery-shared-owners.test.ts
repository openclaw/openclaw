import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { updateSessionEntry } from "../config/sessions/session-accessor.entry-mutation.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { writeSessionSqliteMigrationManifest } from "../infra/session-sqlite-migration-manifest.js";
import * as sqliteReaders from "../infra/session-sqlite-migration-readers.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  readMigrationManifest,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it.each([
    { kind: "transcript", reverse: false },
    { kind: "transcript", reverse: true },
    { kind: "index", reverse: false },
    { kind: "index", reverse: true },
  ])(
    "retains remaining recovery when an admitted $kind disappears (reverse=$reverse)",
    async ({ kind, reverse }) => {
      const { cfg, env, indexes, transcriptPath } = createSharedRecoveryFixture({
        separateIndexes: true,
        reverse,
      });
      const mainIndexPath = path.join(path.dirname(transcriptPath), "main.json");
      const siblingPath = path.join(path.dirname(transcriptPath), "main-private.jsonl");
      const mainIndex = JSON.parse(fs.readFileSync(mainIndexPath, "utf8"));
      mainIndex["agent:main:private"] = {
        sessionId: "main-private",
        sessionFile: "main-private.jsonl",
        updatedAt: 30,
      };
      fs.writeFileSync(mainIndexPath, JSON.stringify(mainIndex));
      fs.writeFileSync(siblingPath, '{"type":"session","id":"main-private","version":3}\n');
      const lastOwner = reverse ? "main" : "work";
      const lostPath =
        kind === "transcript"
          ? transcriptPath
          : path.join(path.dirname(transcriptPath), `${lastOwner}.json`);
      const originals = [...indexes, siblingPath, transcriptPath]
        .filter((file) => file !== lostPath)
        .map((file) => ({ file, bytes: fs.readFileSync(file) }));
      const snapshot = sqliteReaders.readOnlySqliteValidationSnapshot;
      let disappeared = false;
      const spy = vi
        .spyOn(sqliteReaders, "readOnlySqliteValidationSnapshot")
        .mockImplementation((target) => {
          const result = snapshot(target);
          if (
            !disappeared &&
            target.agentId === lastOwner &&
            result.ok &&
            result.snapshot.sessionIdsBySessionKey.has(`agent:${lastOwner}:main`)
          ) {
            // Both owners committed the source; lose recovery input before archival.
            fs.unlinkSync(lostPath);
            disappeared = true;
          }
          return result;
        });
      let imported;
      try {
        imported = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      } finally {
        spy.mockRestore();
      }
      expect(disappeared).toBe(true);
      closeOpenClawAgentDatabasesForTest();
      const retired = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
      for (const original of originals) {
        const locations = [
          original.file,
          ...manifest.targets.flatMap((target) =>
            target.plannedMoves
              .filter((move) => move.sourcePath === original.file)
              .map((move) => move.archivePath),
          ),
        ];
        expect(
          locations.filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file)),
        ).toContainEqual(original.bytes);
      }
      expect(retired.totals.removedFiles).toBe(2);
      const affectedOwners = imported.targets.filter((target) =>
        kind === "transcript" ? indexes.includes(target.storePath) : target.agentId === lastOwner,
      );
      const code =
        kind === "transcript" ? "transcript_archive_failed" : "legacy_store_archive_failed";
      for (const owner of affectedOwners) {
        expect(owner.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
      }
    },
  );

  it.each([false, true])(
    "restores every shared-owner publication before reimport and retirement (separate=%s)",
    async (separateIndexes) => {
      const { cfg, env, indexes, transcriptPath } = createSharedRecoveryFixture({
        separateIndexes,
        reverse: false,
      });
      const originals = [transcriptPath, ...indexes].map((file) => ({
        file,
        bytes: fs.readFileSync(file),
      }));
      const imported = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      expect(imported.targets.flatMap((target) => target.issues)).toEqual([]);
      const current = [];
      for (const owner of ["main", "work"]) {
        const scope = {
          agentId: owner,
          env,
          storePath: expectDefined(
            imported.targets.find((target) => target.agentId === owner),
            "imported owner target",
          ).sqlitePath,
          sessionKey: `agent:${owner}:main`,
        };
        await updateSessionEntry(scope, () => ({ label: `Current ${owner} metadata` }));
        const entry = expectDefined(loadSessionEntry(scope), "current owner entry");
        expect(entry.label).toBe(`Current ${owner} metadata`);
        current.push({ scope, entry: structuredClone(entry) });
      }
      closeOpenClawAgentDatabasesForTest();
      const restored = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "restore" });
      expect(restored.targets.flatMap((target) => target.issues)).toEqual([]);
      for (const original of originals) {
        expect(fs.existsSync(original.file)).toBe(true);
        expect(fs.readFileSync(original.file)).toEqual(original.bytes);
      }
      const reimported = await runDoctorSessionSqlite({
        cfg,
        env,
        allAgents: true,
        mode: "import",
      });
      expect(reimported.targets.flatMap((target) => target.issues)).toEqual([]);
      for (const { scope, entry } of current) {
        expect(loadSessionEntry(scope)).toEqual(entry);
      }
      closeOpenClawAgentDatabasesForTest();
      const retired = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      expect(retired.totals.removedFiles).toBe(separateIndexes ? 5 : 4);
    },
  );

  it("refuses shared-index replay when only another owner's receipt remains", async () => {
    const { cfg, env, indexes } = createSharedRecoveryFixture({
      separateIndexes: false,
      reverse: false,
    });
    const imported = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
    expect(imported.targets.flatMap((target) => target.issues)).toEqual([]);
    const scope = {
      agentId: "main",
      env,
      storePath: expectDefined(
        imported.targets.find((target) => target.agentId === "main"),
        "main target",
      ).sqlitePath,
      sessionKey: "agent:main:main",
    };
    await updateSessionEntry(scope, () => ({ label: "Current main metadata" }));
    const before = structuredClone(expectDefined(loadSessionEntry(scope), "current main entry"));
    expect(before.label).toBe("Current main metadata");
    closeOpenClawAgentDatabasesForTest();
    const restored = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "restore" });
    expect(restored.targets.flatMap((target) => target.issues)).toEqual([]);
    const indexPath = expectDefined(indexes[0], "shared index");
    const original = fs.readFileSync(indexPath);
    const manifestPath = expectDefined(imported.migrationRun, "import run").manifestPath;
    const manifest = readMigrationManifest(manifestPath);
    manifest.targets = manifest.targets.filter((target) => target.agentId !== "main");
    writeSessionSqliteMigrationManifest({ manifestPath, manifest });

    await expect(
      runDoctorSessionSqlite({ cfg, env, agent: "main", mode: "import" }),
    ).rejects.toThrow("Restored session index evidence cannot be verified");
    expect(loadSessionEntry(scope)).toEqual(before);
    expect(fs.readFileSync(indexPath)).toEqual(original);
  });

  it.each(["shared", "distinct", "unreadable", "invalid-entry"] as const)(
    "retains known unselected index recovery (%s)",
    async (coverage) => {
      const { cfg, env, indexes, transcriptPath } = createSharedRecoveryFixture({
        separateIndexes: true,
        reverse: false,
        sharedTranscript: coverage !== "distinct",
      });
      const workIndex = indexes[1]!;
      const siblingSource = path.join(path.dirname(transcriptPath), "main-private.jsonl");
      const mainIndex = JSON.parse(fs.readFileSync(indexes[0]!, "utf8"));
      mainIndex["agent:main:private"] = {
        sessionId: "main-private",
        sessionFile: "main-private.jsonl",
        updatedAt: 30,
      };
      fs.writeFileSync(indexes[0]!, JSON.stringify(mainIndex));
      fs.writeFileSync(siblingSource, '{"type":"session","id":"main-private","version":3}\n');
      const workSource =
        coverage === "distinct"
          ? path.join(path.dirname(transcriptPath), "work-session.jsonl")
          : transcriptPath;
      if (coverage === "unreadable") {
        fs.writeFileSync(workIndex, "{broken");
      }
      if (coverage === "invalid-entry") {
        fs.writeFileSync(
          workIndex,
          JSON.stringify({ "agent:work:main": { sessionFile: "main-session.jsonl" } }),
        );
      }
      const original = fs.readFileSync(workSource);
      const indexBytes = fs.readFileSync(workIndex);
      const report = await runDoctorSessionSqlite({ cfg, env, agent: "main", mode: "import" });
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      expect(fs.existsSync(workSource)).toBe(true);
      expect(fs.readFileSync(workSource)).toEqual(original);
      expect(fs.readFileSync(workIndex)).toEqual(indexBytes);
      expect(cleanup.totals.removedFiles).toBe(coverage === "distinct" ? 3 : 0);
      if (coverage !== "distinct") {
        expect(report.targets[0]?.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "transcript_archive_deferred" }),
          ]),
        );
      }
      expect(report.targets[0]?.archivedUnreferencedJsonlFiles).toEqual([]);
      // Keep the whole retained index usable; a direct retry must not orphan an earlier archive.
      if (coverage !== "distinct") {
        expect(fs.existsSync(siblingSource)).toBe(true);
      }
      if (coverage === "shared") {
        const retry = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
        expect(retry.targets.flatMap((target) => target.issues)).toEqual([]);
        closeOpenClawAgentDatabasesForTest();
        const retired = await retireSessionSqliteRecovery({
          env,
          preview: inspectSessionSqliteRecovery({ cfg, env }),
          readConfig: async () => cfg,
          confirm: async () => true,
        });
        const current = readMigrationManifest(retry.migrationRun?.manifestPath);
        for (const move of current.targets
          .flatMap((target) => target.completedMoves)
          .filter(
            (plannedMove) =>
              plannedMove.kind === "transcript" || plannedMove.kind === "legacy-store",
          )) {
          expect(retired.artifacts.find((item) => item.path === move.archivePath)?.outcome).toBe(
            "removed",
          );
        }
      }
    },
  );

  it.each([
    { separateIndexes: false, reverse: false },
    { separateIndexes: false, reverse: true },
    { separateIndexes: true, reverse: false },
    { separateIndexes: true, reverse: true },
  ])(
    "retains shared recovery through cleanup when one owner fails (separate=$separateIndexes, reverse=$reverse)",
    async ({ separateIndexes, reverse }) => {
      const fixture = createSharedRecoveryFixture({ separateIndexes, reverse });
      const { cfg, env, transcriptPath, indexes, independent } = fixture;
      const original = fs.readFileSync(transcriptPath);
      const snapshot = sqliteReaders.readOnlySqliteValidationSnapshot;
      let injected = false;
      const spy = vi
        .spyOn(sqliteReaders, "readOnlySqliteValidationSnapshot")
        .mockImplementation((target) => {
          const result = snapshot(target);
          if (
            target.agentId === "work" &&
            result.ok &&
            result.snapshot.sessionIdsBySessionKey.has("agent:work:main")
          ) {
            injected = true;
            return { ok: false, error: new Error("injected validation read failure") };
          }
          return result;
        });
      let report;
      try {
        report = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      } finally {
        spy.mockRestore();
      }
      expect(injected).toBe(true);
      expect(
        report.targets
          .filter((target) => indexes.includes(target.storePath))
          .map((target) => target.agentId),
      ).toEqual(reverse ? ["work", "main"] : ["main", "work"]);
      const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
      expect(
        manifest.targets.find((target) => target.agentId === "work")?.validationBeforeArchive,
      ).toBe("failed");
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      const originalLocations = [
        transcriptPath,
        ...manifest.targets.flatMap((target) =>
          target.plannedMoves
            .filter((move) => move.sourcePath === transcriptPath)
            .map((move) => move.archivePath),
        ),
      ];
      expect(
        originalLocations
          .filter((file) => fs.existsSync(file))
          .map((file) => fs.readFileSync(file)),
      ).toContainEqual(original);
      const independentMoves = manifest.targets.find(
        (target) => target.storePath === independent.storePath,
      )!.completedMoves;
      expect(
        independentMoves
          .filter((move) => move.kind === "transcript" || move.kind === "legacy-store")
          .every((move) =>
            cleanup.artifacts.some(
              (item) => item.path === move.archivePath && item.outcome === "removed",
            ),
          ),
      ).toBe(true);
      // Recovery and retry must remain usable with the failed owner's original index and bytes.
      await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "restore" });
      expect(fs.readFileSync(transcriptPath)).toEqual(original);
      expect(indexes.every((index) => fs.existsSync(index))).toBe(true);
      const retried = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      expect(retried.targets.flatMap((target) => target.issues)).toEqual([]);
      closeOpenClawAgentDatabasesForTest();
      const retired = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      const latest = readMigrationManifest(retried.migrationRun?.manifestPath);
      for (const move of latest.targets.flatMap((target) => target.completedMoves)) {
        expect(retired.artifacts.find((item) => item.path === move.archivePath)?.outcome).toBe(
          "removed",
        );
      }
    },
  );

  it.each([false, true])(
    "plans separate indexes before sweeping sibling transcripts (reverse=%s)",
    async (reverse) => {
      const { cfg, env, indexes, transcriptPath } = createSharedRecoveryFixture({
        separateIndexes: true,
        reverse,
        sharedTranscript: false,
      });
      const report = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      expect(report.targets.flatMap((target) => target.issues)).toEqual([]);
      expect(
        report.targets
          .filter((target) => indexes.includes(target.storePath))
          .map((target) => target.agentId),
      ).toEqual(reverse ? ["work", "main"] : ["main", "work"]);
      const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
      for (const target of manifest.targets.filter((candidate) =>
        indexes.includes(candidate.storePath),
      )) {
        const expectedSource = path.join(
          path.dirname(transcriptPath),
          `${target.agentId}-session.jsonl`,
        );
        expect(target.completedMoves).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "transcript", sourcePath: expectedSource }),
          ]),
        );
      }
      closeOpenClawAgentDatabasesForTest();
      const retired = await retireSessionSqliteRecovery({
        env,
        preview: inspectSessionSqliteRecovery({ cfg, env }),
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      expect(retired.totals.removedFiles).toBe(6);
    },
  );
});

function createSharedRecoveryFixture(params: {
  separateIndexes: boolean;
  reverse: boolean;
  sharedTranscript?: boolean;
}) {
  const independent = createLegacyStore({
    agentDirName: "spare",
    transcriptLines: [
      '{"type":"session","id":"session-1","version":3}',
      '{"type":"message","id":"one","parentId":null,"message":{"role":"user","content":"independent"}}',
    ],
  });
  const { env, stateDir } = independent;
  const sessionDir = path.join(stateDir, "shared-session-store");
  fs.mkdirSync(sessionDir, { recursive: true });
  const owners = params.reverse ? ["work", "main"] : ["main", "work"];
  const storePath = path.join(
    sessionDir,
    params.separateIndexes ? "{agentId}.json" : "sessions.json",
  );
  const records = Object.fromEntries(
    owners.map((owner) => {
      const sessionId = params.sharedTranscript === false ? `${owner}-session` : "main-session";
      fs.writeFileSync(
        path.join(sessionDir, `${sessionId}.jsonl`),
        `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n${JSON.stringify({ type: "message", id: "one", parentId: null, message: { role: "user", content: "shared original" } })}\n`,
      );
      return [
        `agent:${owner}:main`,
        { sessionId, sessionFile: `${sessionId}.jsonl`, updatedAt: 20 },
      ];
    }),
  );
  const indexes = params.separateIndexes
    ? owners.map((owner) => {
        const index = storePath.replace("{agentId}", owner);
        fs.writeFileSync(
          index,
          JSON.stringify({ [`agent:${owner}:main`]: records[`agent:${owner}:main`] }),
        );
        return index;
      })
    : [storePath];
  if (!params.separateIndexes) {
    fs.writeFileSync(storePath, JSON.stringify(records));
  }
  const cfg = {
    agents: {
      entries: Object.fromEntries(owners.map((owner) => [owner, { default: owner === "main" }])),
    },
    session: { store: storePath },
  };
  return {
    cfg,
    env,
    indexes,
    independent,
    transcriptPath: path.join(sessionDir, "main-session.jsonl"),
  };
}
