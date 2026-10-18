import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { updateSessionEntry } from "../config/sessions/session-accessor.entry-mutation.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeSessionSqliteMigrationManifest } from "../infra/session-sqlite-migration-manifest.js";
import * as sqliteReaders from "../infra/session-sqlite-migration-readers.js";
import {
  closeOpenClawAgentDatabasesAsync as drainDatabases,
  closeOpenClawAgentDatabasesForTest as closeDatabases,
} from "../state/openclaw-agent-db.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  containsObjects,
  expectFiles,
  snapshotFiles,
} from "./doctor-session-sqlite.publication-spies.test-support.js";
import {
  readMigrationManifest as readManifest,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();
type SharedFixture = ReturnType<typeof createSharedRecoveryFixture>;
type Manifest = ReturnType<typeof readManifest>;
type Report = Awaited<ReturnType<typeof run>>;
type Cleanup = Awaited<ReturnType<typeof retireRecovery>>;
type FixtureScope = Pick<SharedFixture, "cfg" | "env">;

function run(fixture: FixtureScope, mode: "import" | "restore", agent?: string) {
  return runDoctorSessionSqlite({ ...fixture, mode, ...(agent ? { agent } : { allAgents: true }) });
}

async function cleanRun(fixture: FixtureScope, mode: "import" | "restore") {
  const report = await run(fixture, mode);
  expect(report.targets.flatMap((target) => target.issues)).toEqual([]);
  return report;
}

async function importAtCommittedOwner(
  fixture: FixtureScope,
  owner: string,
  inject: () => Error | void,
) {
  const snapshot = sqliteReaders.readOnlySqliteValidationSnapshot;
  const spy = vi
    .spyOn(sqliteReaders, "readOnlySqliteValidationSnapshot")
    .mockImplementation((target) => {
      const result = snapshot(target);
      if (
        target.agentId === owner &&
        result.ok &&
        result.snapshot.sessionIdsBySessionKey.has(`agent:${owner}:main`)
      ) {
        const error = inject();
        if (error) {
          return { ok: false, error };
        }
      }
      return result;
    });
  try {
    return await run(fixture, "import");
  } finally {
    spy.mockRestore();
  }
}

function addPrivateHistory(indexPath: string) {
  const siblingPath = path.join(path.dirname(indexPath), "main-private.jsonl");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  index["agent:main:private"] = {
    sessionId: "main-private",
    sessionFile: "main-private.jsonl",
    updatedAt: 30,
  };
  fs.writeFileSync(indexPath, JSON.stringify(index));
  fs.writeFileSync(siblingPath, '{"type":"session","id":"main-private","version":3}\n');
  return siblingPath;
}

function expectRetained(manifest: Manifest, file: string, bytes: Buffer) {
  const locations = [
    file,
    ...manifest.targets.flatMap((target) =>
      target.plannedMoves
        .filter((move) => move.sourcePath === file)
        .map((move) => move.archivePath),
    ),
  ];
  expect(
    locations
      .filter((location) => fs.existsSync(location))
      .map((location) => fs.readFileSync(location)),
  ).toContainEqual(bytes);
}

function expectOwners(report: Report, indexes: string[], reverse: boolean) {
  expect(
    report.targets
      .filter((target) => indexes.includes(target.storePath))
      .map((target) => target.agentId),
  ).toEqual(reverse ? ["work", "main"] : ["main", "work"]);
}

function expectOutcome(report: Cleanup, archivePath: string, outcome: string) {
  expect(report.artifacts.find((item) => item.path === archivePath)?.outcome).toBe(outcome);
}

function importedMoves(manifest: Manifest, storePath?: string) {
  const targets = storePath
    ? [
        expectDefined(
          manifest.targets.find((target) => target.storePath === storePath),
          "independent target",
        ),
      ]
    : manifest.targets;
  return targets
    .flatMap((target) => target.completedMoves)
    .filter((move) => move.kind === "transcript" || move.kind === "legacy-store");
}

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
      const siblingPath = addPrivateHistory(path.join(path.dirname(transcriptPath), "main.json"));
      const lastOwner = reverse ? "main" : "work";
      const lostPath =
        kind === "transcript"
          ? transcriptPath
          : path.join(path.dirname(transcriptPath), `${lastOwner}.json`);
      const originals = snapshotFiles(
        [...indexes, siblingPath, transcriptPath].filter((file) => file !== lostPath),
      );
      let disappeared = false;
      const imported = await importAtCommittedOwner({ cfg, env }, lastOwner, () => {
        if (!disappeared) {
          // Both owners committed the source; lose recovery input before archival.
          fs.unlinkSync(lostPath);
          disappeared = true;
        }
      });
      expect(disappeared).toBe(true);
      const retired = await retireRecovery(cfg, env);
      const manifest = readManifest(imported.migrationRun?.manifestPath);
      for (const original of originals) {
        expectRetained(manifest, original.file, original.bytes);
      }
      expect(retired.totals.removedFiles).toBe(2);
      const affectedOwners = imported.targets.filter((target) =>
        kind === "transcript" ? indexes.includes(target.storePath) : target.agentId === lastOwner,
      );
      const code =
        kind === "transcript" ? "transcript_archive_failed" : "legacy_store_archive_failed";
      for (const owner of affectedOwners) {
        containsObjects(owner.issues, { code });
      }
    },
  );

  it.each([
    { separateIndexes: false, reverse: false, sharedTranscript: true, missingOwner: false },
    { separateIndexes: true, reverse: false, sharedTranscript: true, missingOwner: false },
    { separateIndexes: false, reverse: false, sharedTranscript: true, missingOwner: true },
    { separateIndexes: true, reverse: false, sharedTranscript: false, missingOwner: false },
    { separateIndexes: true, reverse: true, sharedTranscript: false, missingOwner: false },
  ])(
    "preserves each owner's index and history (separate=$separateIndexes, shared=$sharedTranscript, reverse=$reverse, missingOwner=$missingOwner)",
    async ({ separateIndexes, reverse, sharedTranscript, missingOwner }) => {
      const { cfg, env, indexes, transcriptPath } = createSharedRecoveryFixture({
        separateIndexes,
        reverse,
        sharedTranscript,
      });
      const originals = snapshotFiles([transcriptPath, ...indexes]);
      const imported = await cleanRun({ cfg, env }, "import");
      if (!sharedTranscript) {
        expectOwners(imported, indexes, reverse);
        const manifest = readManifest(imported.migrationRun?.manifestPath);
        for (const target of manifest.targets.filter((candidate) =>
          indexes.includes(candidate.storePath),
        )) {
          containsObjects(target.completedMoves, {
            kind: "transcript",
            sourcePath: path.join(path.dirname(transcriptPath), `${target.agentId}-session.jsonl`),
          });
        }
        expect((await retireRecovery(cfg, env)).totals.removedFiles).toBe(6);
        return;
      }
      const current = [];
      for (const owner of missingOwner ? ["main"] : ["main", "work"]) {
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
      await drainDatabases();
      await cleanRun({ cfg, env }, "restore");
      expect(snapshotFiles(originals.map(({ file }) => file))).toEqual(originals);
      if (missingOwner) {
        const manifestPath = expectDefined(imported.migrationRun, "import run").manifestPath;
        const manifest = readManifest(manifestPath);
        manifest.targets = manifest.targets.filter((target) => target.agentId !== "main");
        writeSessionSqliteMigrationManifest({ manifestPath, manifest });
      }
      const reimported = await run({ cfg, env }, "import", missingOwner ? "main" : undefined);
      if (missingOwner) {
        containsObjects(
          reimported.targets.flatMap((target) => target.issues),
          {
            code: "legacy_import_deferred",
            message: expect.stringContaining("Restored session index evidence cannot be verified"),
          },
        );
        expectFiles(originals[1]!.bytes, indexes[0]!);
      } else {
        expect(reimported.targets.flatMap((target) => target.issues)).toEqual([]);
      }
      for (const { scope, entry } of current) {
        expect(loadSessionEntry(scope)).toEqual(entry);
      }
      if (!missingOwner) {
        expect((await retireRecovery(cfg, env)).totals.removedFiles).toBe(separateIndexes ? 5 : 4);
      }
    },
  );

  it.each(["shared", "distinct", "unreadable", "invalid-entry"] as const)(
    "retains known unselected index recovery (%s)",
    async (coverage) => {
      const { cfg, env, indexes, transcriptPath } = createSharedRecoveryFixture({
        separateIndexes: true,
        reverse: false,
        sharedTranscript: coverage !== "distinct",
      });
      const workIndex = indexes[1]!;
      const siblingSource = addPrivateHistory(indexes[0]!);
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
      const report = await run({ cfg, env }, "import", "main");
      const cleanup = await retireRecovery(cfg, env);
      expect([fs.readFileSync(workSource), fs.readFileSync(workIndex)]).toEqual([
        original,
        indexBytes,
      ]);
      expect(cleanup.totals.removedFiles).toBe(coverage === "distinct" ? 3 : 0);
      if (coverage !== "distinct") {
        containsObjects(report.targets[0]?.issues, { code: "transcript_archive_deferred" });
      }
      expect(report.targets[0]?.archivedUnreferencedJsonlFiles).toEqual([]);
      // Keep the whole retained index usable; a direct retry must not orphan an earlier archive.
      if (coverage !== "distinct") {
        expect(fs.existsSync(siblingSource)).toBe(true);
      }
      if (coverage === "shared") {
        const retry = await cleanRun({ cfg, env }, "import");
        const retired = await retireRecovery(cfg, env);
        const current = readManifest(retry.migrationRun?.manifestPath);
        for (const move of importedMoves(current)) {
          expectOutcome(retired, move.archivePath, "removed");
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
      const supportOriginals = new Map(
        snapshotFiles([independent.trajectoryPath, independent.unreferencedJsonlPath]).map(
          ({ file, bytes }) => [file, bytes],
        ),
      );
      let injected = false;
      const report = await importAtCommittedOwner({ cfg, env }, "work", () => {
        injected = true;
        return new Error("injected validation read failure");
      });
      expect(injected).toBe(true);
      expectOwners(report, indexes, reverse);
      const manifest = readManifest(report.migrationRun?.manifestPath);
      expect(
        manifest.targets.find((target) => target.agentId === "work")?.validationBeforeArchive,
      ).toBe("failed");
      const cleanup = await retireRecovery(cfg, env);
      expectRetained(manifest, transcriptPath, original);
      for (const move of importedMoves(manifest, independent.storePath)) {
        expectOutcome(cleanup, move.archivePath, "removed");
      }
      // Recovery and retry must remain usable with the failed owner's original index and bytes.
      await run({ cfg, env }, "restore");
      expectFiles(original, transcriptPath);
      expect(indexes.every((index) => fs.existsSync(index))).toBe(true);
      const retried = await cleanRun({ cfg, env }, "import");
      const retired = await retireRecovery(cfg, env);
      const latest = readManifest(retried.migrationRun?.manifestPath);
      const protectedSources = new Set<string>();
      for (const move of latest.targets.flatMap((target) => target.completedMoves)) {
        const supportBytes = supportOriginals.get(move.sourcePath);
        if (supportBytes) {
          expect(move).toMatchObject({
            kind: "unreferenced-jsonl",
            artifact: {
              classification: "protected",
              reason: "unreferenced-history",
              disposal: { state: "retained" },
            },
          });
          expectOutcome(retired, move.archivePath, "protected");
          expectFiles(supportBytes, move.archivePath);
          protectedSources.add(move.sourcePath);
          continue;
        }
        expectOutcome(retired, move.archivePath, "removed");
      }
      expect([...protectedSources].toSorted()).toEqual([...supportOriginals.keys()].toSorted());
    },
  );
});

function retireRecovery(
  cfg: ReturnType<typeof createSharedRecoveryFixture>["cfg"],
  env: NodeJS.ProcessEnv,
) {
  closeDatabases();
  return retireSessionSqliteRecovery({
    env,
    preview: inspectSessionSqliteRecovery({ cfg, env }),
    readConfig: async () => cfg,
    confirm: async () => true,
  });
}

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
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: "main" } },
      entries: Object.fromEntries(owners.map((owner) => [owner, {}])),
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
