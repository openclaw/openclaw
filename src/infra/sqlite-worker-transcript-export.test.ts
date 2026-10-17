// Exercise digest recovery through the registered CLI with a suite-owned real worker.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerTranscriptsCli } from "../cli/program/register.transcripts.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptUtterance,
} from "../transcripts/provider-types.js";
import { transcriptSessionExportKey, TranscriptsStore } from "../transcripts/store.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const jsonLines = (text: string): unknown[] =>
  text
    ? text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
const storedUtterances = (sessionId: string, utterances: TranscriptUtterance[]) =>
  utterances.map((utterance) => ({ ...utterance, sessionId }));

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    cleanup();
  }),
);
let suiteStateDir = "";
let nextSessionId = 0;
beforeAll(() => {
  suiteStateDir = tempDirs.make("transcript-export-digest-");
});
beforeEach(() => {
  process.env.OPENCLAW_STATE_DIR = suiteStateDir;
});
afterEach(() => {
  vi.restoreAllMocks();
});

function storeFor(stateDir: string): TranscriptsStore {
  return new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

async function seedDigestRecovery(
  stateDir: string,
  count: number,
  modified = false,
  missingMetadata = false,
) {
  const store = storeFor(stateDir);
  const session: TranscriptSessionDescriptor = {
    sessionId: `digest-recovery-${++nextSessionId}`,
    title: "Captured title",
    source: { providerId: "manual-transcript" },
    startedAt: "2026-05-22T10:00:00.000Z",
  };
  await store.writeSession(session);
  const utterances: TranscriptUtterance[] = Array.from({ length: count }, (_, index) => ({
    id: `line-${index}`,
    startedAt: new Date(Date.UTC(2026, 4, 22, 10, 1, count - index)).toISOString(),
    text: `Line ${index}: 雪\nNUL:\u0000`,
    ...(index % 2 ? { speaker: { id: "speaker", label: "Zoë" } } : {}),
    ...(index % 3 ? { final: index % 3 === 1 } : {}),
    metadata: { order: index, opaque: ["é", false, null] },
  }));
  for (const utterance of utterances) {
    await store.appendUtteranceForSession(session, utterance);
  }
  const artifacts = await store.materializeSessionArtifacts(session, "transcript");
  const original = await fs.readFile(artifacts.transcriptPath, "utf8");
  expect(jsonLines(original)).toEqual(storedUtterances(session.sessionId, utterances));
  const expectedHash = digest(original);
  const database = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  }).db;
  const readManifest = () => {
    const row = database
      .prepare(
        "SELECT export_manifest_json, export_pending_json FROM meeting_transcript_sessions WHERE session_id = ? AND started_at = ?",
      )
      .get(session.sessionId, session.startedAt) as {
      export_manifest_json: string;
      export_pending_json: string;
    };
    return {
      manifest: JSON.parse(row.export_manifest_json) as Record<string, string>,
      pending: JSON.parse(row.export_pending_json) as unknown[],
    };
  };
  const row = readManifest();
  expect(row.pending).toEqual([]);
  const manifest = row.manifest;
  expect(manifest["transcript.jsonl"]).toBe(expectedHash);
  delete manifest["transcript.jsonl"];
  if (missingMetadata) {
    delete manifest["metadata.json"];
  }
  database
    .prepare(
      "UPDATE meeting_transcript_sessions SET export_manifest_json = ? WHERE session_id = ? AND started_at = ?",
    )
    .run(JSON.stringify(manifest), session.sessionId, session.startedAt);
  const expectedBytes = modified ? `${original}changed\n` : original;
  if (modified) {
    await fs.writeFile(artifacts.transcriptPath, expectedBytes);
  }

  return {
    store,
    session,
    utterances,
    artifacts,
    original,
    expectedHash,
    expectedBytes,
    readManifest,
  };
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  try {
    await run();
    return output;
  } finally {
    writeSpy.mockRestore();
  }
}

async function runTranscriptsCli(args: string[]): Promise<string> {
  return captureStdout(async () => {
    const program = new Command().name("openclaw");
    registerTranscriptsCli(program);
    await program.parseAsync(["transcripts", ...args], { from: "user" });
  });
}

async function afterFirstTranscriptArtifactWrite(
  sessionDir: string,
  afterWrite: () => void | Promise<void>,
) {
  const sessionRoots = [sessionDir, await fs.realpath(sessionDir)];
  const open = fs.open;
  let observed = false;
  return vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const [filePath, flags] = args;
    if (
      typeof filePath === "string" &&
      sessionRoots.some((directory) => filePath.startsWith(`${directory}${path.sep}`)) &&
      path.basename(filePath).includes("transcript.jsonl") &&
      (flags === "w" || flags === "wx")
    ) {
      const writeFile = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementation(async (...writeArgs) => {
        await writeFile(...writeArgs);
        if (!observed) {
          observed = true;
          await afterWrite();
        }
      });
    }
    return handle;
  });
}

describe("transcript export digest worker", () => {
  it("preserves the published artifact when its lease is revoked after a temporary file write", async () => {
    const { store, session, artifacts, original, expectedHash, readManifest } =
      await seedDigestRecovery(suiteStateDir, 1);
    await store.materializeSessionArtifacts(session, "metadata");
    expect(readManifest().manifest["transcript.jsonl"]).toBe(expectedHash);
    await store.appendUtteranceForSession(session, {
      id: "unpublished",
      text: "Speech saved after the acknowledged export",
    });
    const filesBefore = await fs.readdir(artifacts.sessionDir);
    const databasePath = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: suiteStateDir },
    }).path;
    const foreign = new DatabaseSync(databasePath);
    const exportKey = transcriptSessionExportKey(session);
    let revoked = false;
    const openSpy = await afterFirstTranscriptArtifactWrite(artifacts.sessionDir, () => {
      const changed = foreign
        .prepare("UPDATE state_leases SET owner = ? WHERE scope = ? AND lease_key = ?")
        .run("foreign-export-owner", "meeting-transcript.export", exportKey);
      expect(changed.changes).toBe(1);
      revoked = true;
    });
    try {
      await expect(store.materializeSessionArtifacts(session, "transcript")).rejects.toMatchObject({
        code: "OPENCLAW_STATE_LEASE_LOST",
      });
      expect(revoked).toBe(true);
      const published = await fs.readFile(artifacts.transcriptPath, "utf8");
      expect(published).toBe(original);
      expect(digest(published)).toBe(expectedHash);
      const manifest = readManifest();
      expect(manifest.manifest["transcript.jsonl"]).toBe(expectedHash);
      expect(manifest.pending).toContain("transcript.jsonl");
      expect((await fs.readdir(artifacts.sessionDir)).toSorted()).toEqual(filesBefore.toSorted());
    } finally {
      openSpy.mockRestore();
      foreign
        .prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ? AND owner = ?")
        .run("meeting-transcript.export", exportKey, "foreign-export-owner");
      foreign.close();
    }
  });

  it.each(["append", "reset"] as const)(
    "keeps one artifact snapshot across a concurrent %s and refreshes the next export",
    async (change) => {
      const { store, session, utterances, artifacts, original, expectedHash, readManifest } =
        await seedDigestRecovery(suiteStateDir, 70);
      await store.materializeSessionArtifacts(session, "metadata");
      const added = { id: "after-snapshot", text: `Speech after ${change}` };
      let changed = false;
      const openSpy = await afterFirstTranscriptArtifactWrite(artifacts.sessionDir, async () => {
        if (change === "reset") {
          const databasePath = openOpenClawStateDatabase({
            env: { OPENCLAW_STATE_DIR: suiteStateDir },
          }).path;
          const foreign = new DatabaseSync(databasePath);
          try {
            foreign.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
            foreign
              .prepare(
                "DELETE FROM meeting_transcript_utterances WHERE session_id = ? AND session_started_at = ?",
              )
              .run(session.sessionId, session.startedAt);
            foreign
              .prepare(
                "DELETE FROM meeting_transcript_summaries WHERE session_id = ? AND session_started_at = ?",
              )
              .run(session.sessionId, session.startedAt);
            foreign
              .prepare(
                "UPDATE meeting_transcript_sessions SET next_utterance_seq = 0 WHERE session_id = ? AND started_at = ?",
              )
              .run(session.sessionId, session.startedAt);
            foreign.exec("COMMIT");
          } finally {
            if (foreign.isTransaction) {
              foreign.exec("ROLLBACK");
            }
            foreign.close();
          }
          await store.writeSession(session);
        }
        await store.appendUtteranceForSession(session, added);
        changed = true;
      });
      try {
        await store.materializeSessionArtifacts(session, "transcript");
        expect(changed).toBe(true);
        expect(await fs.readFile(artifacts.transcriptPath, "utf8")).toBe(original);
        expect(readManifest().manifest["transcript.jsonl"]).toBe(expectedHash);
      } finally {
        openSpy.mockRestore();
      }
      await store.materializeSessionArtifacts(session, "transcript");
      const refreshed = await fs.readFile(artifacts.transcriptPath, "utf8");
      expect(jsonLines(refreshed)).toEqual(
        storedUtterances(session.sessionId, [...(change === "append" ? utterances : []), added]),
      );
      expect(readManifest().manifest["transcript.jsonl"]).toBe(digest(refreshed));
      expect(readManifest().pending).toEqual([]);
    },
  );

  it.each([
    { name: "empty", count: 0, modified: false },
    { name: "modified", count: 70, modified: true },
  ])(
    "checks $name artifact recovery without caller-thread transcript rows",
    async ({ count, modified }) => {
      const { session, artifacts, expectedHash, expectedBytes, readManifest } =
        await seedDigestRecovery(suiteStateDir, count, modified);

      const observed: string[] = [];
      const observe = (sql: string) => {
        if (/^select\b/iu.test(sql) && sql.includes('from "meeting_transcript_utterances"')) {
          observed.push(sql);
        }
      };
      // oxlint-disable-next-line typescript/unbound-method -- Preserve the intercepted native receiver.
      const prepare = DatabaseSync.prototype.prepare;
      const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
        this: DatabaseSync,
        sql,
      ) {
        observe(sql);
        return prepare.call(this, sql);
      });
      // Catch execution even when a preceding export has cached the native statement.
      // oxlint-disable-next-line typescript/unbound-method -- Preserve the intercepted statement receiver.
      const iterate = StatementSync.prototype.iterate;
      const iterateSpy = vi.spyOn(StatementSync.prototype, "iterate").mockImplementation(function (
        this: StatementSync,
        ...args
      ) {
        observe(this.sourceSQL);
        return iterate.apply(this, args);
      });
      try {
        const recovery = runTranscriptsCli(["path", session.sessionId, "--metadata"]);
        if (modified) {
          await expect(recovery).rejects.toThrow("run openclaw doctor --fix");
        } else {
          expect((await recovery).trim()).toBe(artifacts.metadataPath);
        }
        expect(await fs.readFile(artifacts.transcriptPath, "utf8")).toBe(expectedBytes);
        const repaired = readManifest();
        expect(repaired.pending).toEqual([]);
        expect(repaired.manifest["transcript.jsonl"]).toBe(modified ? undefined : expectedHash);
        expect(observed, "artifact recovery read transcript rows on the caller thread").toEqual([]);
      } finally {
        prepareSpy.mockRestore();
        iterateSpy.mockRestore();
      }
    },
  );

  it.each(["append-before-digest", "metadata-before-digest", "append-after-digest"] as const)(
    "preserves concurrent capture during artifact recovery: %s",
    async (change) => {
      const { store, session, utterances, artifacts, original, expectedHash, readManifest } =
        await seedDigestRecovery(
          suiteStateDir,
          change === "append-after-digest" ? 70 : 2,
          false,
          change === "metadata-before-digest",
        );
      const selected = createDeferred();
      const resume = createDeferred();
      let sessionReads = 0;
      const workerSpy = probe.command(stateWorker, async (command, options, scope) => {
        const result = await scope.execute(command, options);
        if (
          (change === "append-after-digest" && command.type === "transcripts.summary") ||
          (change !== "append-after-digest" &&
            command.type === "transcripts.session" &&
            ++sessionReads === 2)
        ) {
          selected.resolve();
          await resume.promise;
        }
        return result;
      });
      const appended = { id: "later", text: "Speech admitted during recovery", final: false };
      let recovery: Promise<string> | undefined;
      try {
        recovery = runTranscriptsCli(["path", session.sessionId, "--metadata"]);
        await selected.promise;
        if (change === "metadata-before-digest") {
          await store.writeSession({ ...session, title: "New canonical title" });
        } else {
          await store.appendUtteranceForSession(session, appended);
        }
        resume.resolve();
        if (change === "append-before-digest") {
          await expect(recovery).rejects.toThrow("run openclaw doctor --fix");
        } else {
          expect((await recovery).trim()).toBe(artifacts.metadataPath);
        }
        expect(await fs.readFile(artifacts.transcriptPath, "utf8")).toBe(original);
        const row = readManifest();
        expect(row.pending).toEqual([]);
        expect(row.manifest["transcript.jsonl"]).toBe(
          change === "append-before-digest" ? undefined : expectedHash,
        );
        if (change === "metadata-before-digest") {
          expect(JSON.parse(await fs.readFile(artifacts.metadataPath, "utf8")).title).toBe(
            "Captured title",
          );
          expect((await store.readSession(session.sessionId))?.title).toBe("New canonical title");
        } else {
          expect(await store.readUtterancesForSession(session)).toEqual(
            storedUtterances(session.sessionId, [...utterances, appended]),
          );
        }
      } finally {
        resume.resolve();
        await Promise.allSettled(recovery ? [recovery] : []);
        workerSpy.mockRestore();
      }
      if (change === "append-after-digest") {
        await runTranscriptsCli(["path", session.sessionId, "--transcript"]);
        const refreshed = await fs.readFile(artifacts.transcriptPath, "utf8");
        expect(refreshed.startsWith(original)).toBe(true);
        expect(jsonLines(refreshed)).toEqual(
          storedUtterances(session.sessionId, [...utterances, appended]),
        );
        expect(readManifest().manifest["transcript.jsonl"]).toBe(digest(refreshed));
      }
    },
  );
});
