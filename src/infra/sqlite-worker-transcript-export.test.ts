import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { Command } from "commander";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
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
  TranscriptSessionDescriptor as Session,
  TranscriptUtterance as Utterance,
} from "../transcripts/provider-types.js";
import { transcriptSessionExportKey, TranscriptsStore } from "../transcripts/store.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function jsonLines(text: string): unknown[] {
  const lines = text ? text.trimEnd().split("\n") : [];
  return lines.map((line) => JSON.parse(line));
}
const storedUtterances = (sessionId: string, utterances: Utterance[]) =>
  utterances.map((utterance) => ({ ...utterance, sessionId }));
type ExportRow = { export_manifest_json: string; export_pending_json: string };

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
const suiteStateDir = tempDirs.make("transcript-export-digest-");
let nextSessionId = 0;
beforeEach(() => {
  process.env.OPENCLAW_STATE_DIR = suiteStateDir;
});
afterEach(() => vi.restoreAllMocks());

async function seed(count: number, modified = false, missingMetadata = false) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: suiteStateDir };
  const store = new TranscriptsStore(path.join(suiteStateDir, "transcripts"), { env });
  const session: Session = {
    sessionId: `digest-recovery-${++nextSessionId}`,
    title: "Captured title",
    source: { providerId: "manual-transcript" },
    startedAt: "2026-05-22T10:00:00.000Z",
  };
  await store.writeSession(session);
  const utterances: Utterance[] = Array.from({ length: count }, (_, index) => ({
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
  const files = await store.materializeSessionArtifacts(session, "transcript");
  const raw = await fs.readFile(files.transcriptPath, "utf8");
  expect(jsonLines(raw)).toEqual(storedUtterances(session.sessionId, utterances));
  const hash = digest(raw);
  const { db: database, path: dbPath } = openOpenClawStateDatabase({ env });
  const read = () => {
    const row = database
      .prepare(
        "SELECT export_manifest_json, export_pending_json FROM meeting_transcript_sessions WHERE session_id = ? AND started_at = ?",
      )
      .get(session.sessionId, session.startedAt) as ExportRow;
    return {
      manifest: JSON.parse(row.export_manifest_json) as Record<string, string>,
      pending: JSON.parse(row.export_pending_json) as unknown[],
    };
  };
  const row = read();
  expect(row.pending).toEqual([]);
  const manifest = row.manifest;
  expect(manifest["transcript.jsonl"]).toBe(hash);
  delete manifest["transcript.jsonl"];
  if (missingMetadata) {
    delete manifest["metadata.json"];
  }
  database
    .prepare(
      "UPDATE meeting_transcript_sessions SET export_manifest_json = ? WHERE session_id = ? AND started_at = ?",
    )
    .run(JSON.stringify(manifest), session.sessionId, session.startedAt);
  const bytes = modified ? `${raw}changed\n` : raw;
  if (modified) {
    await fs.writeFile(files.transcriptPath, bytes);
  }

  async function check(text: string, wantedHash: string | undefined, pending?: string[]) {
    expect(await fs.readFile(files.transcriptPath, "utf8")).toBe(text);
    const current = read();
    expect(current.manifest["transcript.jsonl"]).toBe(wantedHash);
    if (pending) {
      expect(current.pending).toEqual(pending);
    }
  }
  return { store, dbPath, session, utterances, files, raw, hash, bytes, read, check };
}

async function expectRecovery(result: Promise<string>, failed: boolean, metadataPath: string) {
  if (failed) {
    await expect(result).rejects.toThrow("run openclaw doctor --fix");
  } else {
    expect((await result).trim()).toBe(metadataPath);
  }
}

async function runCli(args: string[]): Promise<string> {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    const program = new Command().name("openclaw");
    registerTranscriptsCli(program);
    await program.parseAsync(["transcripts", ...args], { from: "user" });
    return output;
  } finally {
    writeSpy.mockRestore();
  }
}

async function afterWrite(sessionDir: string, onWrite: () => void | Promise<void>) {
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
          await onWrite();
        }
      });
    }
    return handle;
  });
}

it("preserves the published artifact when its lease is revoked after a temporary file write", async () => {
  const { store, dbPath, session, files, raw, hash, read, check } = await seed(1);
  await store.materializeSessionArtifacts(session, "metadata");
  expect(read().manifest["transcript.jsonl"]).toBe(hash);
  await store.appendUtteranceForSession(session, {
    id: "unpublished",
    text: "Speech saved after the acknowledged export",
  });
  const filesBefore = await fs.readdir(files.sessionDir);
  const foreign = new DatabaseSync(dbPath);
  const exportKey = transcriptSessionExportKey(session);
  const openSpy = await afterWrite(files.sessionDir, () => {
    const changed = foreign
      .prepare("UPDATE state_leases SET owner = ? WHERE scope = ? AND lease_key = ?")
      .run("foreign-export-owner", "meeting-transcript.export", exportKey);
    expect(changed.changes).toBe(1);
  });
  try {
    await expect(store.materializeSessionArtifacts(session, "transcript")).rejects.toMatchObject({
      code: "OPENCLAW_STATE_LEASE_LOST",
    });
    await check(raw, hash, expect.arrayContaining(["transcript.jsonl"]));
    expect((await fs.readdir(files.sessionDir)).toSorted()).toEqual(filesBefore.toSorted());
  } finally {
    openSpy.mockRestore();
    foreign
      .prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ? AND owner = ?")
      .run("meeting-transcript.export", exportKey, "foreign-export-owner");
    foreign.close();
  }
});

it.each(["append", "reset"] as const)("exports stable snapshots during %s", async (change) => {
  const { store, dbPath, session, utterances, files, raw, hash, read, check } = await seed(70);
  await store.materializeSessionArtifacts(session, "metadata");
  const added = { id: "after-snapshot", text: `Speech after ${change}` };
  const openSpy = await afterWrite(files.sessionDir, async () => {
    if (change === "reset") {
      const foreign = new DatabaseSync(dbPath);
      try {
        foreign.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
        for (const table of ["utterances", "summaries"]) {
          foreign
            .prepare(
              `DELETE FROM meeting_transcript_${table} WHERE session_id = ? AND session_started_at = ?`,
            )
            .run(session.sessionId, session.startedAt);
        }
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
  });
  try {
    await store.materializeSessionArtifacts(session, "transcript");
    await check(raw, hash);
  } finally {
    openSpy.mockRestore();
  }
  await store.materializeSessionArtifacts(session, "transcript");
  const refreshed = await fs.readFile(files.transcriptPath, "utf8");
  expect(jsonLines(refreshed)).toEqual(
    storedUtterances(session.sessionId, [...(change === "append" ? utterances : []), added]),
  );
  expect(read().manifest["transcript.jsonl"]).toBe(digest(refreshed));
  expect(read().pending).toEqual([]);
});

it.each([
  { name: "empty", count: 0, modified: false },
  { name: "modified", count: 70, modified: true },
])("recovers $name artifacts off-thread", async ({ count, modified }) => {
  const { session, files, hash, bytes, check } = await seed(count, modified);

  const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare");
  const executed: string[] = [];
  // oxlint-disable-next-line typescript/unbound-method -- Preserve the native receiver.
  const iterate = StatementSync.prototype.iterate;
  const iterateSpy = vi.spyOn(StatementSync.prototype, "iterate").mockImplementation(function (
    this: StatementSync,
    ...args
  ) {
    executed.push(this.sourceSQL);
    return iterate.apply(this, args);
  });
  try {
    const recovery = runCli(["path", session.sessionId, "--metadata"]);
    await expectRecovery(recovery, modified, files.metadataPath);
    await check(bytes, modified ? undefined : hash, []);
    const sql = [...prepareSpy.mock.calls.map(([query]) => query), ...executed];
    expect(
      sql.filter(
        (query) =>
          /^select\b/iu.test(query) && query.includes('from "meeting_transcript_utterances"'),
      ),
      "artifact recovery read transcript rows on the caller thread",
    ).toEqual([]);
  } finally {
    prepareSpy.mockRestore();
    iterateSpy.mockRestore();
  }
});

it.each(["append-before-digest", "metadata-before-digest", "append-after-digest"] as const)(
  "preserves concurrent capture during artifact recovery: %s",
  async (change) => {
    const { store, session, utterances, files, raw, hash, read, check } = await seed(
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
      recovery = runCli(["path", session.sessionId, "--metadata"]);
      await selected.promise;
      if (change === "metadata-before-digest") {
        await store.writeSession({ ...session, title: "New canonical title" });
      } else {
        await store.appendUtteranceForSession(session, appended);
      }
      resume.resolve();
      await expectRecovery(recovery, change === "append-before-digest", files.metadataPath);
      await check(raw, change === "append-before-digest" ? undefined : hash, []);
      if (change === "metadata-before-digest") {
        expect(JSON.parse(await fs.readFile(files.metadataPath, "utf8")).title).toBe(
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
      await runCli(["path", session.sessionId, "--transcript"]);
      const refreshed = await fs.readFile(files.transcriptPath, "utf8");
      expect(refreshed.startsWith(raw)).toBe(true);
      expect(jsonLines(refreshed)).toEqual(
        storedUtterances(session.sessionId, [...utterances, appended]),
      );
      expect(read().manifest["transcript.jsonl"]).toBe(digest(refreshed));
    }
  },
);
