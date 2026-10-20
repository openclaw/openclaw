import fs from "node:fs";
import { expect, it } from "vitest";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import { createTranscriptEventReader } from "../infra/session-sqlite-migration-readers.js";
import { formatSessionSqliteMigrationWarnings } from "./doctor-session-sqlite-warnings.js";
import { jsonl, sessionScope } from "./doctor-session-sqlite.fixtures.test-support.js";
import {
  readMigrationManifest,
  runPublicSessionSqlite,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();
const textBlocks = (value: string) => [{ type: "text", text: value }];
function transcriptMessage(id: string, parentId: string | null, role: string, content: string) {
  return { type: "message", id, parentId, message: { role, content: textBlocks(content) } };
}

it.each([
  "matching",
  "suffix",
  "stored-legacy",
  "stored-legacy-suffix",
  "branch",
  "conflict",
  "middle",
  "unknown",
] as const)(
  "retries an interrupted legacy provider import with %s history through Doctor",
  async (history) => {
    const header = {
      type: "session",
      version: 3,
      id: "session-1",
      timestamp: "2026-08-30T00:00:00Z",
      cwd: "/fixture",
    };
    const storedLegacy = history === "stored-legacy" || history === "stored-legacy-suffix";
    const appendSuffix = history === "suffix" || history === "stored-legacy-suffix";
    const first = transcriptMessage("one", null, "assistant", "preserved history");
    const message = {
      ...first,
      message: {
        ...first.message,
        provider: "openai-codex",
        api: "openai-codex-responses",
      },
    };
    const events: unknown[] = [header, message];
    if (history === "branch") {
      for (const [id, parentId, role, text] of [
        [
          "shadow",
          "one",
          "user",
          "hello\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nold context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        ],
        ["abandoned", "shadow", "assistant", "old answer"],
        ["visible", "one", "user", "hello"],
        ["answer", "visible", "assistant", "kept answer"],
      ] as const) {
        events.push(transcriptMessage(id, parentId, role, text));
      }
    }
    const store = createLegacyStore({
      transcriptLines: events.map((event) => JSON.stringify(event)),
    });
    const scope = sessionScope(store);
    // The real importer committed, but Doctor has not archived any source yet.
    await importSqliteSessionRows({
      ...scope,
      entry: { sessionId: "session-1", updatedAt: 2000 },
      repairLegacyTranscript: !storedLegacy,
      readTranscriptEvents: createTranscriptEventReader(store.transcriptPath, "session-1"),
    });
    const stored = loadTranscriptEventsSync(scope);
    expect(stored[1]).toMatchObject({
      message: {
        provider: storedLegacy ? "openai-codex" : "openai",
        api: storedLegacy ? "openai-codex-responses" : "openai-chatgpt-responses",
      },
    });
    const suffix = transcriptMessage("two", "one", "user", "new history");
    if (history === "conflict") {
      message.message.content = textBlocks("changed history");
    }
    const extra = history === "unknown" ? { type: "unrecognized", id: "opaque" } : suffix;
    const retryEvents =
      history === "middle"
        ? [header, { ...suffix, parentId: null }, message]
        : [...events, ...(appendSuffix || history === "unknown" ? [extra] : [])];
    retryEvents.push({ ...header, timestamp: "2026-08-29T00:00:00Z" });
    const original = jsonl(...retryEvents);
    fs.writeFileSync(store.transcriptPath, original);
    const originalIndex = fs.readFileSync(store.storePath, "utf8");

    const { report, exitCode } = await runPublicSessionSqlite(store, "import");
    const target = report.targets[0]!;
    const receipt = readMigrationManifest(report.migrationRun?.manifestPath).targets[0]!;
    if (history === "matching" || history === "branch" || storedLegacy || appendSuffix) {
      expect(target.issues).toEqual([]);
      expect(exitCode).toBe(0);
      expect(receipt.validationBeforeArchive).toBe("passed");
      expect(loadTranscriptEventsSync(scope)).toEqual(appendSuffix ? [...stored, suffix] : stored);
      expect(target.importedTranscriptEvents).toBe(appendSuffix ? 1 : 0);
      for (const [sourcePath, bytes] of [
        [store.transcriptPath, original],
        [store.storePath, originalIndex],
      ] as const) {
        expect(fs.existsSync(sourcePath)).toBe(false);
        const move = receipt.completedMoves.find((row) => row.sourcePath === sourcePath)!;
        expect(fs.readFileSync(move.archivePath, "utf8")).toBe(bytes);
        if (sourcePath === store.transcriptPath && appendSuffix) {
          expect(move.artifact?.classification).toBe("repair-original");
        }
      }
      expect(() =>
        assertSessionStoreMigrationComplete({ cfg: {}, env: store.env, operation: "doctor" }),
      ).not.toThrow();
    } else {
      expect(exitCode).toBe(1);
      expect(target.issues).toContainEqual(
        expect.objectContaining({ code: "sqlite_transcript_count_mismatch" }),
      );
      expect(receipt).toMatchObject({ validationBeforeArchive: "failed", completedMoves: [] });
      expect(fs.readFileSync(store.transcriptPath, "utf8")).toBe(original);
      expect(fs.readFileSync(store.storePath, "utf8")).toBe(originalIndex);
      expect(loadTranscriptEventsSync(scope)).toEqual(stored);
      expect(formatSessionSqliteMigrationWarnings(report.targets, store.env)).toContainEqual(
        expect.stringContaining("[sqlite_transcript_count_mismatch]"),
      );
    }
  },
);
