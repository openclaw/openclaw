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
import { TranscriptsStore } from "../transcripts/store.js";

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
  expect(
    original
      ? original
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [],
  ).toEqual(
    utterances.map((utterance) => Object.assign({}, utterance, { sessionId: session.sessionId })),
  );
  const expectedHash = createHash("sha256").update(original).digest("hex");
  const database = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  }).db;
  const readManifest = () =>
    database
      .prepare(
        "SELECT export_manifest_json, export_pending_json FROM meeting_transcript_sessions WHERE session_id = ? AND started_at = ?",
      )
      .get(session.sessionId, session.startedAt) as {
      export_manifest_json: string;
      export_pending_json: string;
    };
  const row = readManifest();
  expect(JSON.parse(row.export_pending_json)).toEqual([]);
  const manifest = JSON.parse(row.export_manifest_json) as Record<string, string>;
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

describe("transcript export digest worker", () => {
  it.each([
    { name: "complete", count: 70, modified: false },
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
      const prepareSpy = vi
        .spyOn(DatabaseSync.prototype, "prepare")
        .mockImplementation(function (this: DatabaseSync, sql) {
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
        expect(JSON.parse(repaired.export_pending_json)).toEqual([]);
        expect(JSON.parse(repaired.export_manifest_json)["transcript.jsonl"]).toBe(
          modified ? undefined : expectedHash,
        );
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
        await seedDigestRecovery(suiteStateDir, 2, false, change === "metadata-before-digest");
      const selected = createDeferred();
      const resume = createDeferred();
      let sessionReads = 0;
      const runOperation = stateWorker.runOpenClawStateWorkerOperation;
      const workerSpy = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        new Proxy(runOperation, {
          apply(target, receiver, [context, operation, options]: Parameters<typeof runOperation>) {
            return Reflect.apply(target, receiver, [
              context,
              (scope: Parameters<typeof operation>[0]) =>
                operation({
                  execute: new Proxy(scope.execute, {
                    async apply(execute, executeReceiver, args: Parameters<typeof scope.execute>) {
                      const result = await Reflect.apply(execute, executeReceiver, args);
                      if (
                        (change === "append-after-digest" &&
                          args[0].type === "transcripts.summary") ||
                        (change !== "append-after-digest" &&
                          args[0].type === "transcripts.session" &&
                          ++sessionReads === 2)
                      ) {
                        selected.resolve();
                        await resume.promise;
                      }
                      return result;
                    },
                  }),
                }),
              options,
            ]);
          },
        }),
      );
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
        expect(JSON.parse(row.export_pending_json)).toEqual([]);
        expect(JSON.parse(row.export_manifest_json)["transcript.jsonl"]).toBe(
          change === "append-before-digest" ? undefined : expectedHash,
        );
        if (change === "metadata-before-digest") {
          expect(JSON.parse(await fs.readFile(artifacts.metadataPath, "utf8")).title).toBe(
            "Captured title",
          );
          expect((await store.readSession(session.sessionId))?.title).toBe("New canonical title");
        } else {
          expect(await store.readUtterancesForSession(session)).toEqual(
            [...utterances, appended].map((utterance) =>
              Object.assign({}, utterance, { sessionId: session.sessionId }),
            ),
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
        expect(
          refreshed
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual(
          [...utterances, appended].map((utterance) =>
            Object.assign({}, utterance, { sessionId: session.sessionId }),
          ),
        );
        expect(JSON.parse(readManifest().export_manifest_json)["transcript.jsonl"]).toBe(
          createHash("sha256").update(refreshed).digest("hex"),
        );
      }
    },
  );
});
