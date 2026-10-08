import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendTranscriptEvent } from "../config/sessions/session-accessor.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  recordCompletedMigrationMoves,
  recordPlannedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationMove,
} from "../infra/session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  detectSessionTranscriptHealthIssues,
  sessionTranscriptIssueToHealthFinding,
  sessionTranscriptIssueToRepairEffect,
  noteSessionTranscriptHealth,
} from "./doctor-session-transcripts.js";

describe("doctor session transcript health", () => {
  let root: string;
  beforeEach(async () => {
    root = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-transcripts-")),
    );
  });
  afterEach(async () => {
    await fsPromises.rm(root, { recursive: true, force: true });
  });
  async function writeTranscript(entries: unknown[]): Promise<string> {
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fsPromises.mkdir(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, "session.jsonl");
    await fsPromises.writeFile(
      filePath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    return filePath;
  }

  it("does not label a vanished file as broken", async () => {
    const code = "ENOENT";

    const filePath = await writeTranscript([{ type: "session", id: "uninspected" }]);
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockRejectedValueOnce(Object.assign(new Error("unavailable transcript"), { code }));
    try {
      await expect(
        detectSessionTranscriptHealthIssues({ sessionDirs: [path.dirname(filePath)] }),
      ).resolves.toEqual([]);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("maps affected transcripts to structured findings and dry-run effects", async () => {
    const filePath = await writeTranscript([
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
    const sessionsDir = path.dirname(filePath);

    const [issue] = await detectSessionTranscriptHealthIssues({ sessionDirs: [sessionsDir] });

    if (!issue) {
      throw new Error("expected session transcript health issue");
    }
    expect(issue?.filePath).toBe(filePath);
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

    const filePath = await writeTranscript([]);
    await fsPromises.writeFile(filePath, raw);
    await expect(
      detectSessionTranscriptHealthIssues({ sessionDirs: [path.dirname(filePath)] }),
    ).resolves.toEqual([]);
    expect(await fsPromises.readFile(filePath, "utf8")).toBe(raw);
  });

  it("defers large transcripts without reading their contents", async () => {
    const filePath = await writeTranscript([
      { type: "message", message: { content: "x".repeat(1024 * 1024) } },
    ]);
    const readSpy = vi.spyOn(fs, "readFile");
    try {
      const [issue] = await detectSessionTranscriptHealthIssues({
        sessionDirs: [path.dirname(filePath)],
      });
      expect(issue).toMatchObject({ filePath, deferred: true, broken: false });
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });
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
        agentId: "main",
        env: state.env,
        storePath,
        sessionKey: "agent:main:main",
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
          {
            agentId: "main",
            env: state.env,
            storePath,
            sessionKey: "agent:main:main",
            sessionId: "session-1",
          },
          {
            type: "custom",
            id: "later",
            parentId: "message-1",
            customType: "later",
            data: "later data ".repeat(256),
          },
        );
      }
      const database = openNodeSqliteDatabase(target.sqlitePath);
      try {
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
      } finally {
        database.close();
      }
      const run = createSessionSqliteMigrationRun(state.env, [target]);
      const move: SessionSqliteMigrationMove = {
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
      recordPlannedMigrationMoves(run, target, [move]);
      recordCompletedMigrationMoves(run, target, [move]);
      updateMigrationManifestTarget(run, target, [], { validationBeforeArchive: "passed" });
      run.manifest.completedAt = new Date().toISOString();
      writeSessionSqliteMigrationManifest(run);
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
        if (complete) {
          expect(message).toContain("Canonical SQLite transcripts are complete");
          expect(message).toContain("legacy index entries are informational");
          expect(message).not.toContain('Run "openclaw doctor --fix" to migrate');
          expect(message).not.toContain("Inspect with");
        } else {
          expect(message).not.toContain("Canonical SQLite transcripts are complete");
          expect(message).toContain('Run "openclaw doctor --fix" to migrate');
        }
        expect(fs.readFileSync(transcriptPath)).toEqual(before);
        expect(fs.existsSync(storePath)).toBe(false);
        expect(fs.existsSync(move.archivePath)).toBe(false);
      }
    });
  },
);
