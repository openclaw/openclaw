import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { appendTranscriptEvent } from "../config/sessions/session-accessor.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import * as migration from "../infra/session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  detectSessionTranscriptHealthIssues,
  sessionTranscriptIssueToHealthFinding,
  sessionTranscriptIssueToRepairEffect,
  noteSessionTranscriptHealth,
} from "./doctor-session-transcripts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const detect = (filePath: string) =>
  detectSessionTranscriptHealthIssues({ sessionDirs: [path.dirname(filePath)] });

function writeTranscript(entries: unknown[] | string): string {
  const filePath = path.join(tempDirs.make("openclaw-doctor-transcripts-"), "session.jsonl");
  fs.writeFileSync(
    filePath,
    typeof entries === "string"
      ? entries
      : `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  return filePath;
}

it("does not label a vanished file as broken", async () => {
  const filePath = writeTranscript([{ type: "session", id: "uninspected" }]);
  const readSpy = vi
    .spyOn(fsPromises, "readFile")
    .mockRejectedValueOnce(Object.assign(new Error("unavailable transcript"), { code: "ENOENT" }));
  await expect(detect(filePath)).resolves.toEqual([]);
  expect(readSpy).toHaveBeenCalledExactlyOnceWith(filePath, "utf-8");
});

it("maps affected transcripts to structured findings and dry-run effects", async () => {
  const filePath = writeTranscript([
    { type: "session", version: 3, id: "session-1", timestamp: "2026-04-25T00:00:00Z" },
    {
      type: "message",
      id: "legacy-assistant",
      parentId: null,
      message: {
        role: "assistant",
        provider: "openai-codex",
        api: "openai-codex-responses",
        content: [{ type: "text", text: "hello" }],
      },
    },
  ]);
  const issue = expectDefined((await detect(filePath))[0], "session transcript health issue");
  expect(sessionTranscriptIssueToHealthFinding(issue)).toMatchObject({
    checkId: "core/doctor/session-transcripts",
    severity: "info",
    path: filePath,
    fixHint: expect.stringContaining("openclaw doctor --fix"),
  });
  expect(sessionTranscriptIssueToRepairEffect(issue)).toEqual({
    kind: "file",
    action: "would-rewrite-session-transcript",
    target: filePath,
    dryRunSafe: false,
  });
  expect(await fsPromises.readFile(filePath, "utf-8")).toContain("openai-codex");
});

it("does not report malformed JSON as a transcript issue", async () => {
  const raw = "{\n";

  const filePath = writeTranscript(raw);
  await expect(detect(filePath)).resolves.toEqual([]);
  expect(await fsPromises.readFile(filePath, "utf8")).toBe(raw);
});

it("defers large transcripts without reading their contents", async () => {
  const filePath = writeTranscript([
    { type: "message", message: { content: "x".repeat(1024 * 1024) } },
  ]);
  const readSpy = vi.spyOn(fs, "readFile");
  const promiseReadSpy = vi.spyOn(fsPromises, "readFile");
  const [issue] = await detect(filePath);
  expect(issue).toMatchObject({ filePath, deferred: true, broken: false });
  expect(readSpy).not.toHaveBeenCalled();
  expect(promiseReadSpy).not.toHaveBeenCalled();
});

const note = vi.hoisted(() => vi.fn());

// mock-isolation: Capture Doctor notes while leaving the real import and repair owners active.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

afterEach(() => note.mockClear());

it.each([true, false])(
  "reports missing legacy indexes as informational only when canonical transcript bytes match (%s)",
  async (complete) => {
    await withOpenClawTestState({ label: "doctor-missing-index" }, async (state) => {
      const sessions = state.sessionsDir("main");
      fs.mkdirSync(sessions, { recursive: true });
      const storePath = path.join(sessions, "sessions.json");
      const transcriptPath = path.join(sessions, "session-1.jsonl");
      const scope = { agentId: "main", env: state.env, storePath, sessionKey: "agent:main:main" };
      const events = [
        { type: "session", version: 3, id: "session-1", timestamp: "", cwd: "" },
        {
          type: "message",
          id: "message-1",
          parentId: null,
          message: { role: "user", content: "canonical history 雪🦞 ".repeat(128) },
        },
      ];
      const original = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
      fs.writeFileSync(transcriptPath, original);
      await importSqliteSessionRows({
        ...scope,
        entry: { sessionId: "session-1", updatedAt: 1, label: "Existing title" },
        readTranscriptEvents: (append) => events.forEach(append),
      });
      fs.writeFileSync(storePath, "{}");
      const target = {
        agentId: "main",
        storePath,
        sqlitePath: resolveTargetSqlitePath({ agentId: "main", storePath }, state.env),
      };
      if (complete) {
        await appendTranscriptEvent(
          { ...scope, sessionId: "session-1" },
          {
            type: "custom",
            id: "later",
            parentId: "message-1",
            customType: "later",
            data: "later data ".repeat(256),
          },
        );
      }
      {
        using database = openNodeSqliteDatabase(target.sqlitePath);
        expect(
          database
            .prepare(`SELECT event_json, event_zstd IS NOT NULL AS compressed
              FROM transcript_events WHERE session_id = ? AND seq = 1`)
            .get("session-1"),
        ).toEqual({ event_json: null, compressed: 1 });
        if (complete) {
          // Verification must stop after proving the retained source, before decoding newer history.
          expect(
            database
              .prepare(`UPDATE transcript_events SET event_zstd = x'010203'
                WHERE session_id = ? AND seq = 2 AND event_zstd IS NOT NULL`)
              .run("session-1").changes,
          ).toBe(1);
        }
      }
      const run = migration.createSessionSqliteMigrationRun(state.env, [target]);
      const move: migration.SessionSqliteMigrationMove = {
        kind: "legacy-store",
        sourcePath: storePath,
        archivePath: path.join(
          path.dirname(sessions),
          "session-sqlite-import-archive",
          "missing-index",
        ),
        artifact: {
          identity: readMigrationArtifactIdentity(storePath),
          classification: "protected",
          reason: "incomplete-index-import",
          dependencies: [transcriptPath],
          disposal: { state: "retained" },
        },
      };
      migration.recordPlannedMigrationMoves(run, target, [move]);
      migration.recordCompletedMigrationMoves(run, target, [move]);
      migration.updateMigrationManifestTarget(run, target, [], {
        validationBeforeArchive: "passed",
      });
      run.manifest.completedAt = new Date().toISOString();
      migration.writeSessionSqliteMigrationManifest(run);
      fs.unlinkSync(storePath);
      if (!complete) {
        fs.writeFileSync(
          transcriptPath,
          original.replace("canonical history", "unimported history"),
        );
      }
      const before = fs.readFileSync(transcriptPath);
      for (let attempt = 0; attempt < 2; attempt++) {
        note.mockClear();
        await noteSessionTranscriptHealth({
          cfg: {},
          env: state.env,
          shouldRepair: false,
          postSessionPluginMigrationPlanBound: true,
        });
        const message = note.mock.calls
          .filter(([, title]) => title === "Session SQLite")
          .map(([text]) => String(text))
          .join("\n");
        expect(message.includes("Stored SQLite transcripts are complete")).toBe(complete);
        expect(message.includes('Run "openclaw doctor --fix" to migrate')).toBe(!complete);
        if (complete) {
          expect(message).toContain("legacy index entries are informational");
          expect(message).not.toContain("Inspect with");
        }
        expect(fs.readFileSync(transcriptPath)).toEqual(before);
        expect([storePath, move.archivePath].map(fs.existsSync)).toEqual([false, false]);
      }
    });
  },
);
