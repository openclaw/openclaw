import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, expect, it, vi } from "vitest";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
} from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import * as directoryDurability from "../infra/directory-durability.js";
import { countBlockingSessionSqliteIssues } from "./doctor-session-sqlite-types.js";
import {
  archivedSource,
  migrationManifest,
  jsonl,
  expectIssue,
  withRetainedSource,
  writeJson,
} from "./doctor-session-sqlite.fixtures.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  expectMissing,
  expectFiles,
} from "./doctor-session-sqlite.publication-spies.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("preserves a transcript when its index changes during archive publication", () =>
  withRetainedSource(async ({ storePath, run, readEntry, file }) => {
    await run();
    const transcript = file("legacy-kept.jsonl");
    const changed = fs
      .readFileSync(transcript, "utf8")
      .replace('"content":"kept"', '"content":"conflict"');
    fs.writeFileSync(transcript, changed);
    const publish = directoryDurability.publishFileExclusive;
    let changedIndex = false;
    vi.spyOn(directoryDurability, "publishFileExclusive").mockImplementation(
      async (publication) => {
        const result = await publish(publication);
        if (publication.sourcePath === transcript) {
          const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
          entries["agent:main:new"] = {
            sessionId: "new",
            sessionFile: path.basename(transcript),
            updatedAt: 30,
          };
          writeJson(storePath, entries);
          changedIndex = true;
        }
        return result;
      },
    );
    const result = await run();
    expect(changedIndex).toBe(true);
    expect(result.totals.archivedTranscriptFiles).toBe(0);
    expectFiles(changed, transcript);
    expect(fs.statSync(transcript).nlink).toBe(1);
    expectIssue(result, {
      message: expect.stringContaining("Session index changed after owner discovery"),
    });
    expect(readEntry("agent:main:new")).toBeUndefined();
  }));

it.each(["valid", "invalid"] as const)(
  "reverifies a changed %s retained index without replaying canonical metadata",
  (kind) =>
    withRetainedSource(
      async ({ storePath, run, readEntry, writeEntry, readEvents, assertReady }) => {
        expect((await run()).totals).toMatchObject({ importedEntries: 2, sqliteEntries: 2 });
        await writeEntry("agent:main:kept", { label: "current" });
        const keys = ["agent:main:kept"];
        if (kind === "valid") {
          keys.push("agent:main:created-after-import");
          await writeEntry(keys[1]!, {
            sessionId: "new-canonical",
            updatedAt: 30,
            label: "current",
          });
        }
        const readCurrent = () => keys.map(readEntry);
        const current = readCurrent();
        const originalEvents = readEvents("legacy-kept");
        if (kind === "valid") {
          fs.appendFileSync(storePath, "\r\n");
        } else {
          fs.writeFileSync(storePath, Buffer.from('{"agent:main:kept":\r\n'));
          expect(assertReady).not.toThrow();
        }
        const bytes = fs.readFileSync(storePath);
        const repaired = await run();
        expect(repaired.totals).toMatchObject({
          importedEntries: 0,
          sqliteEntries: kind === "valid" ? 3 : 2,
        });
        expect(
          repaired.targets.every((target) => countBlockingSessionSqliteIssues(target) === 0),
        ).toBe(true);
        expectIssue(repaired, {
          code:
            kind === "valid"
              ? "retained_plugin_source_index_rebuilt"
              : "retained_plugin_source_conflict",
          message: expect.stringContaining(storePath),
        });
        expect(readCurrent()).toEqual(current);
        expect(assertReady).not.toThrow();
        if (kind === "valid") {
          expectFiles(bytes, storePath);
        } else {
          const archived = archivedSource(repaired, storePath);
          expect(archived.artifact).toMatchObject({
            classification: "protected",
            disposal: { state: "retained" },
          });
          expectFiles(bytes, archived.archivePath);
          expectMissing(storePath);
          const events = readEvents("legacy-kept");
          expect(events).toHaveLength(2);
          expect(events).toEqual(originalEvents);
          expect((await run("inspect")).totals.sqliteEntries).toBe(2);
          expectFiles(bytes, archived.archivePath);
        }
      },
      kind === "valid" ? "default" : "external",
      "codex",
    ),
);

it("reconciles a smaller retained index and reports only its differing session metadata", () =>
  withRetainedSource(async ({ storePath, readEntry, run, assertReady }) => {
    const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
    for (let index = 0; index < 10; index += 1) {
      entries[`agent:main:unchanged-${index}`] = {
        sessionId: `unchanged-${index}`,
        updatedAt: 20,
      };
    }
    entries["agent:main:kept"].skillsSnapshot = { prompt: "original", skills: [] };
    entries["agent:main:deleted"].inputTokens = 100;
    fs.writeFileSync(storePath, JSON.stringify(entries).padEnd(190_020));
    const imported = await run("import");
    expect(imported.totals.sqliteEntries).toBe(12);
    const readCanonical = () => Object.keys(entries).map(readEntry);
    const canonical = readCanonical();
    const manifestPath = expectDefined(imported.migrationRun?.manifestPath, "import manifest");
    const failed = migrationManifest(imported);
    failed.failedAt = failed.startedAt;
    const failedTarget = expectDefined(failed.targets[0], "failed target");
    failedTarget.issues = [];
    failedTarget.validationBeforeArchive = "not_run";
    writeJson(manifestPath, failed);
    entries["agent:main:kept"].skillsSnapshot.prompt = "runtime snapshot";
    entries["agent:main:kept"].updatedAt = 21;
    entries["agent:main:deleted"].inputTokens = 200;
    const changed = JSON.stringify(entries).padEnd(187_332);
    fs.writeFileSync(storePath, changed);
    const recovered = await run("recover");
    const report = expectDefined(recovered.targets[0], "recovered target");
    expect(report).toMatchObject({ sqliteEntries: 12, importedEntries: 0 });
    expect(countBlockingSessionSqliteIssues(report)).toBe(0);
    expect(readCanonical()).toEqual(canonical);
    const archive = expectDefined(report.archivedLegacyStoreFiles?.[0], "protected index");
    expectFiles(changed, archive);
    expectMissing(storePath);
    expect(assertReady).not.toThrow();
    expect(report.issues.filter((issue) => issue.sessionKey)).toMatchObject([
      {
        code: "retained_plugin_source_conflict",
        sessionKey: "agent:main:kept",
        message: expect.stringContaining("skillsSnapshot, updatedAt"),
      },
      {
        code: "retained_plugin_source_conflict",
        sessionKey: "agent:main:deleted",
        message: expect.stringContaining("inputTokens"),
      },
    ]);
    const readFailure = (format: "Json" | "Markdown") =>
      fs.readFileSync(
        expectDefined(recovered.migrationRun?.[`failureReport${format}Path`], format),
        "utf8",
      );
    const failureJson = JSON.parse(readFailure("Json"));
    expect(failureJson.targets[0].recoveryIssues.map(({ code }: { code: string }) => code)).toEqual(
      report.issues.map(({ code }) => code),
    );
    const markdown = readFailure("Markdown");
    expect(markdown).toContain(`Current recovery issues: ${report.issues.length}`);
    expect(markdown).toContain("skillsSnapshot, updatedAt");
    expect(markdown).toContain("inputTokens");
  }));

it.each([
  { reversed: false, foreign: false },
  { reversed: true, foreign: false },
  { reversed: false, foreign: true },
])(
  "binds changed shared transcripts to every indexed session (reversed: $reversed, foreign: $foreign)",
  ({ reversed, foreign }) =>
    withRetainedSource(async ({ storePath, scope, run, readEvents, state, file }) => {
      const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
      const foreignPath = state.path("foreign-root/agents/main/sessions/legacy-deleted.jsonl");
      entries["agent:main:kept"].sessionFile = foreign ? foreignPath : "legacy-deleted.jsonl";
      fs.unlinkSync(file("legacy-kept.jsonl"));
      writeJson(
        storePath,
        reversed ? Object.fromEntries(Object.entries(entries).toReversed()) : entries,
      );
      await run();
      const kept = readEvents("legacy-kept");
      expect(kept).toHaveLength(2);
      await appendTranscriptEvent(
        { ...scope, sessionId: "legacy-deleted", sessionKey: "agent:main:deleted" },
        {
          type: "custom",
          id: "only-deleted",
          parentId: "deleted-message",
          timestamp: "2026-09-01T00:00:00.000Z",
          customType: "fixture",
          data: { owner: "deleted" },
        },
      );
      const transcript = file("legacy-deleted.jsonl");
      const current = readEvents("legacy-deleted");
      fs.writeFileSync(transcript, jsonl(...current));
      if (foreign) {
        fs.mkdirSync(path.dirname(foreignPath), { recursive: true });
        fs.copyFileSync(transcript, foreignPath);
      }
      const bytes = fs.readFileSync(transcript);
      const result = await run();
      expect(result.totals.importedEntries).toBe(0);
      expectMissing(transcript);
      const archived = archivedSource(result, transcript).archivePath;
      expectFiles(bytes, archived);
      expect(readEvents("legacy-kept")).toEqual(kept);
      expect(readEvents("legacy-deleted")).toEqual(current);
      if (foreign) {
        expectFiles(bytes, foreignPath);
      }
    }),
);

it("keeps a truncated shared index until every owner is selected", () =>
  withRetainedSource(async ({ cfg, storePath, scope, readEntry, state, assertReady }) => {
    cfg.agents = {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: "main" } },
      entries: { main: {}, ops: {} },
    };
    const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
    entries["agent:ops:waiting"] = { sessionId: "legacy-ops", updatedAt: 20 };
    writeJson(storePath, entries);
    const options = { cfg, env: state.env, mode: "import" as const };
    const importMain = () =>
      runDoctorSessionSqlite({ ...options, store: storePath, agent: "main" });
    await importMain();
    entries["agent:main:kept"].sessionId = "unimported-new-main";
    delete entries["agent:ops:waiting"];
    const changed = JSON.stringify(entries);
    fs.writeFileSync(storePath, changed);
    const partial = await importMain();
    expectFiles(changed, storePath);
    expect(partial.totals.archivedLegacyStoreFiles).toBe(0);
    const ops = { ...scope, agentId: "ops", sessionKey: "agent:ops:waiting" };
    expectMissing(resolveSqliteTargetFromSessionStorePath(storePath, ops).path);
    const unrelated = path.join(state.sessionsDir("retired"), "sessions.json");
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    writeJson(unrelated, { "agent:retired:old": { sessionId: "old", updatedAt: 10 } });
    const completed = await runDoctorSessionSqlite({ ...options, allAgents: true });
    expect(completed.totals.importedEntries).toBe(1);
    expectMissing(storePath);
    expect(readEntry("agent:main:kept")?.entry.sessionId).toBe("legacy-kept");
    expect(loadExactSessionEntry(ops)?.entry.sessionId).toBeUndefined();
    expect(assertReady).not.toThrow();
  }, "external"));

it("protects an unindexed source replaced with a later canonical transcript", () =>
  withRetainedSource(async ({ scope, run, readEvents, file, assertReady }) => {
    const source = file("legacy-later.jsonl");
    fs.writeFileSync(source, '{"type":"custom","unimported":true}\n');
    await run();
    expectFiles('{"type":"custom","unimported":true}\n', source);
    const later = { ...scope, sessionKey: "agent:main:later", sessionId: "legacy-later" };
    expect(loadExactSessionEntry(later)).toBeUndefined();
    await upsertSessionEntryCore(later, { sessionId: later.sessionId, updatedAt: 30 });
    const header = readEvents("legacy-kept")[0];
    assert(isRecord(header));
    await appendTranscriptEvent(later, { ...header, id: later.sessionId });
    await appendTranscriptMessage(later, { message: { role: "user", content: "later" } });
    const events = loadTranscriptEventsSync(later);
    const replacement = jsonl(...events);
    fs.writeFileSync(source, replacement);
    const result = await run();
    expect(result.totals.importedEntries).toBe(0);
    const archive = archivedSource(result, source).archivePath;
    expectFiles(replacement, archive);
    expectMissing(source);
    expect(loadTranscriptEventsSync(later)).toEqual(events);
    expectIssue(result, {
      message: expect.stringContaining("no verified indexed owner"),
    });
    expect(assertReady).not.toThrow();
  }));
