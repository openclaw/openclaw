import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPTS_EXPORT_MAX_BYTES as EXPORT_LIMIT,
  TRANSCRIPTS_RESULT_MAX_BYTES as READ_LIMIT,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createTranscriptCaptureAppends } from "./capture-appends.js";
import { activeSessions } from "./capture-startup.js";
import { transcriptLibraryTimezoneEntrypoint } from "./library-timezone-runtime.test-support.js";
import { exportTranscriptLibrary, getTranscriptLibrary, listTranscriptLibrary } from "./library.js";
import { observeArchiveReads } from "./library.query-budget.test-support.js";
import {
  createTranscriptLibraryStoreFixture,
  transcriptLibrarySession as session,
} from "./library.store.test-support.js";
import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";
import { readTranscriptLibraryStatus } from "./status.js";
import { deriveMeetingTranscriptSummaryColumns } from "./store-columns.js";
import { cursorScope, encodeCursor } from "./store-read.js";
import { readTranscriptSessionMatches } from "./store-sqlite-read.js";
import { meetingTranscriptDb } from "./store-sqlite.js";
import { transcriptSessionSelector } from "./store.js";
import { summarizeTranscripts } from "./summary.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  activeSessions.clear();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

type Target = string | TranscriptSessionDescriptor;
type ReadOptions = Omit<Parameters<typeof getTranscriptLibrary>[1], "selector">;
const selectorOf = (target: Target) =>
  typeof target === "string" ? target : transcriptSessionSelector(target);
function fixture() {
  const context = createTranscriptLibraryStoreFixture(tempDirs.make("transcript-library-"));
  const { store } = context;
  const get = (target: Target, params: ReadOptions = {}) =>
    getTranscriptLibrary(store, { selector: selectorOf(target), ...params });
  return {
    ...context,
    get,
    list: (params: Parameters<typeof listTranscriptLibrary>[1] = {}) =>
      listTranscriptLibrary(store, params),
    download: (target: Target, format: "markdown" | "jsonl") =>
      exportTranscriptLibrary(store, { selector: selectorOf(target), format }),
    seed: async (target: TranscriptSessionDescriptor, utterances: TranscriptUtterance[] = []) => {
      await store.writeSession(target);
      for (const utterance of utterances) {
        await store.appendUtteranceForSession(target, utterance);
      }
    },
    summary: (target: TranscriptSessionDescriptor, utterances: TranscriptUtterance[]) =>
      store.writeSummary(summarizeTranscripts({ session: target, utterances }), target),
  };
}

async function captured(id: string, utterances: TranscriptUtterance[] = []) {
  const context = fixture();
  const target = session(id);
  await context.seed(target, utterances);
  return { ...context, target, selector: transcriptSessionSelector(target) };
}

function contents(exported: { data: string }) {
  return Buffer.from(exported.data, "base64").toString("utf8");
}

function jsonLines(exported: { data: string }): Record<string, unknown>[] {
  return contents(exported)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("transcript library SQLite reads", () => {
  it("retains meeting chronology when reopened in another process timezone", async ({ signal }) => {
    const stateDir = tempDirs.make("transcript-library-timezone-");
    const argv = resolveRuntimeWorkerArgv(
      resolveRuntimeWorkerUrl(transcriptLibraryTimezoneEntrypoint),
    );
    for (const [phase, timezone] of [
      ["write", "America/Los_Angeles"],
      ["read", "UTC"],
    ] as const) {
      await promisify(execFile)(process.execPath, [...argv, stateDir, phase], {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, TZ: timezone },
        signal,
      });
    }
  });

  it("skips empty transcription artifacts without losing pagination or rewriting the archive", async () => {
    const { store, get, download, seed } = fixture();
    const target = session("transcription-artifacts");
    const texts = ["context:", "###", "Transcribe the audio.", "Context: ship the fix.", "はい。"];
    await seed(
      target,
      texts.map((text) => ({ text })),
    );
    let cursor: string | undefined;
    const visible: string[] = [];
    do {
      const page = await get(transcriptSessionSelector(target), {
        includeUtterances: true,
        limit: 1,
        cursor,
      });
      visible.push(...(page.utterances ?? []).map((utterance) => utterance.text));
      if (!page.nextCursor) {
        break;
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(visible).toEqual(texts.slice(3));
    const exported = await download(transcriptSessionSelector(target), "jsonl");
    expect(jsonLines(exported).map((line) => line.text)).toEqual(texts.slice(3));
    expect(
      (await store.readUtterancesForSession(target)).map((utterance) => utterance.text),
    ).toEqual(texts);
  });

  it("paginates equal instants and unknown dates using original identity ties and date-string semantics", async () => {
    const { store, list } = fixture();
    const ordered = [
      session("later", { startedAt: "2026-08-20T06:30:00Z" }),
      session("fraction-tail", { startedAt: "2026-08-20T06:00:00.9999Z" }),
      session("basic", { startedAt: "2026-08-20T06:00:00+0000" }),
      session("fraction", { startedAt: "2026-08-20T06:00:00.0005Z" }),
      session("same", { startedAt: "2026-08-19T23:00:00-07:00" }),
      session("same", { startedAt: "2026-08-20T06:00:00.000Z" }),
      session("earlier", { startedAt: "2026-08-20T05:30:00Z" }),
      session("unknown", { startedAt: "2026-08-21Tbad" }),
      session("unknown", { startedAt: "2026-08-22Tbad" }),
      session("unknown-z", { startedAt: "2026-08-20Tbad" }),
    ];
    for (const row of ordered.toReversed()) {
      await store.writeSession(row);
    }
    let cursor: string | undefined;
    for (const [index, expected] of ordered.entries()) {
      const page = await list({ limit: 1, cursor });
      expect(page.sessions).toHaveLength(1);
      expect(page.sessions[0]).toMatchObject({
        sessionId: expected.sessionId,
        startedAt: expected.startedAt,
        selector: transcriptSessionSelector(expected),
      });
      expect(page.nextCursor).toEqual(index === ordered.length - 1 ? null : expect.any(String));
      cursor = page.nextCursor ?? undefined;
    }
    expect(
      (
        await list({
          startedAfter: "2026-08-20T06:00:00.0005Z",
          startedBefore: "2026-08-20T06:00:00.001Z",
        })
      ).sessions.map(({ sessionId }) => sessionId),
    ).toEqual(["basic", "fraction", "same", "same"]);
  });

  it("requests a fresh page when its cursor session was deleted", async () => {
    const { store, list } = fixture();
    const target = session("removed-cursor", {
      startedAt: "2026-08-21T06:00:00Z",
      stoppedAt: "2026-08-21T06:01:00Z",
    });
    const receipt = await store.writeSession(target);
    await store.writeSession(session("older-cursor", { startedAt: "2026-08-20T06:00:00Z" }));
    const first = await list({ limit: 1 });
    expect(first.nextCursor).toEqual(expect.any(String));
    await store.deleteEmptySessionCandidate(target, {
      expectedInputRevision: receipt.inputRevision,
      assertCurrent() {},
    });
    await expect(list({ limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({
      type: "transcript_invalid_cursor",
    });
  });

  it("preserves ID-only stored speakers across legacy reads, pages, and exports", async () => {
    const { database, get, download, seed } = fixture();
    const target = session("speaker-id-only");
    const selector = transcriptSessionSelector(target);
    await seed(target, [
      {
        id: "speech-id",
        text: "Saved speech",
        speaker: { id: "speaker-id", label: "Stored label" },
      },
    ]);
    const db = database();
    executeSqliteQuerySync(
      db,
      meetingTranscriptDb(db)
        .updateTable("meeting_transcript_utterances")
        .set({
          speaker_label: null,
          metadata_json: JSON.stringify({ private: "x".repeat(2 * READ_LIMIT) }),
        })
        .where("session_id", "=", target.sessionId)
        .where("session_started_at", "=", target.startedAt),
    );
    for (const limit of [undefined, 1]) {
      const read = await get(selector, { includeUtterances: true, limit });
      expect(read.utterances?.[0]).toMatchObject({ speakerId: "speaker-id", text: "Saved speech" });
      expect(read.utterances?.[0]?.speakerLabel).toBeUndefined();
      expect(read.utterances?.[0]?.id).toBe(limit === undefined ? undefined : "speech-id");
    }
    const exported = await download(selector, "jsonl");
    expect(JSON.parse(contents(exported))).toEqual({
      sequence: 0,
      id: "speech-id",
      speakerId: "speaker-id",
      text: "Saved speech",
    });
  });

  it("combines literal title/source search, exact owner/account/provider filters and inclusive/exclusive dates", async () => {
    const { store, list } = fixture();
    const source = {
      providerId: "room-provider",
      accountId: "work",
      channelId: "room-a",
      kind: "live-audio" as const,
    };
    await store.writeSession(
      session("one", { title: "100% Launch_review", source, metadata: { agentId: "ops" } }),
    );
    await store.writeSession(
      session("two", {
        source,
        metadata: { agentId: "main" },
        startedAt: "2026-08-21T10:00:00.000Z",
      }),
    );
    await store.writeSession(session("legacy", { source }));
    const filters = {
      providerId: "room-provider",
      accountId: "work",
      agentId: "ops",
      startedAfter: "2026-08-20T03:00:00-07:00",
      startedBefore: "2026-08-21T10:00:00Z",
    };
    for (const query of ["% LAUNCH_", "ROOM-A"]) {
      expect((await list({ ...filters, query })).sessions.map((entry) => entry.sessionId)).toEqual([
        "one",
      ]);
    }
    expect((await list({ ...filters, accountId: "personal" })).sessions).toEqual([]);
    expect((await list({ ...filters, providerId: "different" })).sessions).toEqual([]);
    expect((await list({ agentId: "main" })).sessions.map((entry) => entry.sessionId)).toEqual([
      "two",
    ]);
    expect(
      (await list()).sessions.find((entry) => entry.sessionId === "legacy")?.agentId,
    ).toBeNull();
    await expect(list({ startedAfter: "bad date" })).rejects.toThrow("date filter");
    await expect(list({ startedAfter: "2026-08-22", startedBefore: "2026-08-21" })).rejects.toThrow(
      "range",
    );
  });

  it("preserves full canonical handles and pages/searches durable utterances without reading exports", async () => {
    const { store, stateDir, list, get, download, seed, summary } = fixture();
    const hidden = [
      "fixture-user-amber",
      "fixture-pass-cobalt",
      "fixture-query-violet",
      "fixture-fragment-ochre",
    ];
    const meetingUrl = new URL(`https://example.test/room?invite=${hidden[2]}#${hidden[3]}`);
    meetingUrl.username = hidden[0]!;
    meetingUrl.password = hidden[1]!;
    const target = session("standup:@room?opaque", {
      title: "Public planning",
      source: {
        providerId: "meet",
        accountId: "public-account",
        guildId: "public-guild",
        channelId: "public-channel",
        threadTs: "public-thread",
        fileId: "public-file",
        meetingUrl: meetingUrl.href,
        privateKey: "not-for-ui",
      },
      metadata: { private: "not-for-ui" },
    });
    const utterances = [
      {
        text: "First decision: approved.",
        speaker: { label: "Sam", id: "speaker-1" },
        startedAt: "2026-08-20T10:01:00.000Z",
        final: true,
      },
      { text: "Background." },
      {
        text: "Follow up: FIRST milestone.",
        endedAt: "2026-08-20T10:03:00.000Z",
        metadata: { private: "not-for-ui" },
      },
    ];
    await seed(target, utterances);
    await summary(target, utterances);
    // Reopen a raw legacy-shaped URL row without Doctor or read-time normalization.
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const selector = (await list()).sessions[0]!.selector;
    for (const query of [
      "PLANNING",
      "opaque",
      "meet",
      "public-account",
      "public-guild",
      "public-channel",
      "public-thread",
      "public-file",
      "FIRST MILESTONE",
    ]) {
      expect(
        (await list({ query })).sessions.map((entry) => entry.selector),
        query,
      ).toEqual([selector]);
    }
    for (const query of [
      ...hidden.flatMap((part) => [part, part.slice(0, -3).toUpperCase()]),
      "invite",
      "example.test",
    ]) {
      expect((await store.listReadEntries({ query })).entries, query).toEqual([]);
      expect((await list({ query })).sessions, query).toEqual([]);
    }
    const pageOptions = { includeUtterances: true, limit: 1, query: "first" };
    const first = await get(selector, pageOptions);
    expect(first.session).toMatchObject({
      selector: transcriptSessionSelector(target),
      sessionId: target.sessionId,
      utteranceCount: 3,
      lastUtteranceAt: "2026-08-20T10:03:00.000Z",
      activeSubscription: false,
      source: { providerId: "meet", meetingUrl: "https://example.test/room" },
    });
    expect(first.utterances).toEqual([
      {
        sequence: 0,
        text: utterances[0]!.text,
        speakerId: "speaker-1",
        speakerLabel: "Sam",
        startedAt: utterances[0]!.startedAt,
        final: true,
      },
    ]);
    expect(first.summary).toMatchObject({ utteranceCount: 3 });
    expect(first.summary).not.toHaveProperty("transcript");
    const last = await get(selector, { ...pageOptions, cursor: first.nextCursor! });
    expect(last.utterances).toEqual([
      { sequence: 2, text: utterances[2]!.text, endedAt: "2026-08-20T10:03:00.000Z" },
    ]);
    expect(last.nextCursor).toBeNull();
    expect(JSON.stringify(first)).not.toContain("private");
    const publicOutputs = [JSON.stringify(first), JSON.stringify(await list())];
    for (const format of ["markdown", "jsonl"] as const) {
      const content = contents(await download(selector, format));
      expect(content).toContain("First decision: approved.");
      expect(content).toContain("Follow up: FIRST milestone.");
      publicOutputs.push(content);
    }
    for (const output of publicOutputs) {
      for (const part of hidden) {
        expect(output).not.toContain(part);
      }
    }
    expect((await store.readSession(selector))?.source.meetingUrl).toBe(meetingUrl.href);
    expect(fs.existsSync(path.join(stateDir, "transcripts"))).toBe(false);
    await expect(get(target.sessionId)).rejects.toThrow("not found");
  });

  it("rejects malformed and cross-filter, cross-transcript or cross-method cursors", async () => {
    const { list, get, seed } = fixture();
    for (const id of ["one", "two"]) {
      const target = session(id);
      await seed(target, [{ text: "a" }, { text: "b" }]);
    }
    const listed = await list({ limit: 1 });
    const selector = listed.sessions[0]!.selector;
    const read = await get(selector, { includeUtterances: true, limit: 1 });
    await expect(list({ cursor: "not-a-cursor" })).rejects.toThrow("cursor");
    await expect(list({ cursor: listed.nextCursor!, agentId: "other" })).rejects.toThrow("cursor");
    await expect(get(selector, { cursor: listed.nextCursor! })).rejects.toThrow("cursor");
    await expect(get(selector, { cursor: read.nextCursor!, query: "a" })).rejects.toThrow("cursor");
    await expect(
      get(transcriptSessionSelector(session("two")), { cursor: read.nextCursor! }),
    ).rejects.toThrow("cursor");
  });

  it.each(["structured-only", "markdown-only"] as const)(
    "exports full canonical content with %s notes even when the stored summary covers only a tail",
    async (notesKind) => {
      const { store, stateDir, database, get, download, seed, summary } = fixture();
      const target = session("download");
      const action = { text: "Action: verify downloads" };
      await seed(target, [
        {
          text: "Opening context",
          id: "utterance-1",
          speaker: { label: "Alex", id: "speaker-1" },
          startedAt: "2026-08-20T10:01:00.000Z",
          metadata: { recordingPath: "/private/provider/audio.wav", private: "provider-only" },
        },
        action,
      ]);
      await summary(target, [action]);
      const canonicalMarkdown =
        "# Historical notes\r\n\r\nKeep this exact historical decision.\r\n";
      const db = database();
      updateSummary(db, target, {
        markdown: notesKind === "structured-only" ? null : canonicalMarkdown,
        ...(notesKind === "markdown-only"
          ? { summary_json: null, ...deriveMeetingTranscriptSummaryColumns(null) }
          : {}),
      });
      const selector = transcriptSessionSelector(target);
      const markdown = await download(selector, "markdown");
      const text = contents(markdown);
      if (notesKind === "markdown-only") {
        const projectedMarkdown =
          "# Historical notes\\r\n\\r\nKeep this exact historical decision.\\r\n";
        expect((await get(selector)).summary?.markdown).toBe(projectedMarkdown);
        expect(text).toContain(projectedMarkdown);
      }
      expect(text).toContain("Alex: Opening context");
      expect(text).toContain("Action: verify downloads");
      expect(text).toContain("Transcript utterances: 2");
      if (notesKind !== "markdown-only") {
        expect(text).toContain("Summary covers 1 saved utterances.");
      }
      expect(markdown.filename).toMatch(/^transcript-2026-08-20-[a-f0-9]{12}\.md$/);
      expect(markdown.sizeBytes).toBe(Buffer.byteLength(text));
      const jsonl = await download(selector, "jsonl");
      expect(jsonLines(jsonl)).toEqual(
        (await get(selector, { includeUtterances: true, limit: 50 })).utterances,
      );
      expect(contents(jsonl)).not.toContain("provider-only");
      expect((await store.readUtterancesForSession(target))[0]?.metadata).toEqual({
        recordingPath: "/private/provider/audio.wav",
        private: "provider-only",
      });
      expect(fs.existsSync(path.join(stateDir, "transcripts"))).toBe(false);
    },
  );

  it("leaves missing summaries missing and rejects oversized reads/downloads without partial output", async () => {
    const { store, stateDir, get, download, target, selector } = await captured("large");
    expect((await get(selector)).summary).toBeUndefined();
    expect(contents(await download(selector, "markdown"))).not.toContain("## Overview");
    await store.appendUtteranceForSession(target, {
      text: "x".repeat(READ_LIMIT + 1),
    });
    await expectResultTooLarge(get(selector, { includeUtterances: true, limit: 50 }));
    for (const format of ["jsonl", "markdown"] as const) {
      const exported = await download(selector, format);
      expectExportSize(exported);
    }
    await store.appendUtteranceForSession(target, {
      text: "x".repeat(EXPORT_LIMIT),
    });
    for (const format of ["jsonl", "markdown"] as const) {
      await expectExportTooLarge(download(selector, format));
    }
    expect(fs.existsSync(path.join(stateDir, "transcripts"))).toBe(false);
    expect(await store.readNotes(target)).toEqual({});
  });
});

describe("transcript library asynchronous reads", () => {
  it.each(["list", "get", "export"] as const)(
    "keeps a delayed composed %s response coherent after a peer update",
    async (kind) => {
      const { store, list, get, download, seed, summary } = fixture();
      const target = session("delayed-read", { title: "Original meeting" });
      const utterance = { text: "Original saved note" };
      await seed(target, [utterance]);
      await summary(target, [utterance]);
      const selector = transcriptSessionSelector(target);
      const gate = createDeferred();
      const reading = createDeferred();
      function delayed<T extends (...args: never[]) => Promise<unknown>>(operation: T): T {
        return new Proxy(operation, {
          async apply(invoke, receiver, args) {
            const snapshot = await Reflect.apply(invoke, receiver, args);
            reading.resolve();
            await gate.promise;
            return snapshot;
          },
        });
      }
      if (kind === "list") {
        vi.spyOn(store, "listReadEntries").mockImplementationOnce(
          delayed(store.listReadEntries.bind(store)),
        );
      } else if (kind === "get") {
        vi.spyOn(store, "readLibraryEntry").mockImplementationOnce(
          delayed(store.readLibraryEntry.bind(store)),
        );
      } else {
        vi.spyOn(store, "streamExport").mockImplementationOnce(
          delayed(store.streamExport.bind(store)),
        );
      }
      const read = async () =>
        kind === "list"
          ? JSON.stringify(await list())
          : kind === "get"
            ? JSON.stringify(await get(selector, { includeUtterances: true, limit: 1 }))
            : contents(await download(selector, "markdown"));
      const settled = vi.fn();
      const result = read();
      const settlement = result.then(settled, settled);
      const replacement = { ...target, title: "Replacement meeting" };
      const added = { text: "Peer saved note" };
      try {
        await reading.promise;
        await setImmediate();
        expect(settled).not.toHaveBeenCalled();
        await seed(replacement, [added]);
        await summary(replacement, [utterance, added]);
      } finally {
        gate.resolve();
        await settlement;
      }
      const text = await result;
      if (kind !== "list") {
        expect(text).toContain("## Overview");
      }
      expect(text).toContain(target.title);
      expect(text).toContain(utterance.text);
      expect(text).not.toContain(replacement.title);
      expect(text).not.toContain(added.text);
      expect((await store.readSession(selector))?.title).toBe(replacement.title);
      expect(await store.readUtterancesForSession(replacement)).toMatchObject([utterance, added]);
    },
  );
});

const emptySummary = (target: ReturnType<typeof session>) =>
  summarizeTranscripts({ session: target, utterances: [] });
const searchPage = (result: Awaited<ReturnType<typeof listTranscriptLibrary>>) => ({
  ids: result.sessions.map((entry) => entry.selector),
  cursor: result.nextCursor,
});

it("searches stored notes and speech once per capture with stable filtered pagination", async () => {
  const { store, list } = fixture();
  const phrase = '100% launch_ "review"';
  const source = { providerId: "manual-transcript", accountId: "work" };
  const common = { source, metadata: { agentId: "ops" } };
  const speech = session("recurring", { ...common, startedAt: "2026-08-21T10:00:00Z" });
  const notes = session("notes", common);
  const otherOwner = session("other-owner", { ...common, metadata: { agentId: "main" } });
  for (const target of [speech, notes, session("recurring", common), otherOwner]) {
    await store.writeSession(target);
  }
  for (const target of [speech, otherOwner]) {
    await store.appendUtteranceForSession(target, { text: phrase });
    await store.appendUtteranceForSession(target, { text: phrase });
  }
  await store.writeSummary({ ...emptySummary(notes), decisions: [phrase] }, notes);
  const filters = {
    query: phrase.toUpperCase(),
    ...source,
    agentId: "ops",
    startedAfter: "2026-08-20T00:00:00Z",
    startedBefore: "2026-08-22T00:00:00Z",
    limit: 1,
  };
  const first = await list(filters);
  expect(searchPage(first)).toEqual({
    ids: [transcriptSessionSelector(speech)],
    cursor: expect.any(String),
  });
  const second = await list({ ...filters, cursor: first.nextCursor! });
  expect(searchPage(second)).toEqual({ ids: [transcriptSessionSelector(notes)], cursor: null });
  expect((await list({ ...filters, accountId: "personal" })).sessions).toEqual([]);
});

it("finds historical structured overviews and canonical Markdown notes", async () => {
  const { store, database, list, target } = await captured("historical-notes");
  await store.writeSummary({ ...emptySummary(target), overview: "Overview" }, target);
  const db = database();
  const expected = [transcriptSessionSelector(target)];
  for (const [query, fields] of [
    ["OVERVIEW", { markdown: null }],
    ["MARKDOWN", { markdown: "Markdown", summary_json: null, overview: null }],
  ] as const) {
    updateSummary(db, target, fields);
    expect(searchPage(await list({ query })).ids).toEqual(expected);
  }
});

function updateSummary(
  db: EngineConnection,
  target: TranscriptSessionDescriptor,
  fields: { markdown?: string | null; summary_json?: string | null; overview?: string | null },
) {
  executeSqliteQuerySync(
    db,
    meetingTranscriptDb(db)
      .updateTable("meeting_transcript_summaries")
      .set(fields)
      .where("session_id", "=", target.sessionId)
      .where("session_started_at", "=", target.startedAt),
  );
}
function expectExportTooLarge(result: Promise<unknown>) {
  return expect(result).rejects.toThrow(
    expect.objectContaining({
      type: "transcript_export_too_large",
      maxBytes: EXPORT_LIMIT,
    }),
  );
}

function expectRowBound(reads: ReturnType<typeof observeArchiveReads>, limit = READ_LIMIT) {
  expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(limit);
}
function expectExportSize(exported: { sizeBytes: number }) {
  expect(exported.sizeBytes).toBeGreaterThan(READ_LIMIT);
  expect(exported.sizeBytes).toBeLessThan(EXPORT_LIMIT);
}
function expectResultTooLarge(result: Promise<unknown>, maxBytes?: number) {
  return expect(result).rejects.toThrow(
    expect.objectContaining({
      type: "transcript_result_too_large",
      ...(maxBytes === undefined ? {} : { maxBytes }),
    }),
  );
}

function seedExportBookkeeping(db: EngineConnection) {
  executeSqliteQuerySync(
    db,
    meetingTranscriptDb(db)
      .updateTable("meeting_transcript_sessions")
      .set({
        export_manifest_json: JSON.stringify({ "retained-export.md": "x".repeat(16_384) }),
        export_pending_json: JSON.stringify(["x".repeat(16_384)]),
      }),
  );
}

describe("transcript library SQLite query budgets", () => {
  it.each(["session matches", "summary snapshot"])(
    "omits export bookkeeping from %s",
    async (kind) => {
      const { store, database } = fixture();
      const first = session("review");
      const later = session("review", { startedAt: "2026-08-21T10:00:00.000Z" });
      const collision = session("review?", { startedAt: "2026-08-22T10:00:00.000Z" });
      for (const target of [first, later, collision]) {
        await store.writeSession(target);
      }
      await store.appendUtteranceForSession(later, { text: "Summarize this speech" });
      const db = database();
      seedExportBookkeeping(db);
      const malformedSummaryColumns = deriveMeetingTranscriptSummaryColumns("{malformed");
      executeSqliteQuerySync(
        db,
        meetingTranscriptDb(db)
          .insertInto("meeting_transcript_summaries")
          .values(
            [first, collision].map((target) => ({
              session_id: target.sessionId,
              session_started_at: target.startedAt,
              summary_json: "{malformed",
              overview: malformedSummaryColumns.overview,
              utterance_count: 0,
            })),
          ),
      );
      const reads = observeArchiveReads(store, db);
      if (kind === "session matches") {
        const matches = readTranscriptSessionMatches(db, "review");
        expect(matches.qualified).toEqual([]);
        expect(matches.unqualified).toMatchObject([
          { session: later, hasSummary: false },
          { session: first, hasSummary: true },
          { session: collision, hasSummary: true },
        ]);
        expect(reads.reduce((count, read) => count + read.executions, 0)).toBeLessThanOrEqual(3);
      } else {
        expect(await store.readSummarySnapshot(later, 20)).toMatchObject({
          nextSequence: 1,
          summaryRevision: "",
          utterances: [{ text: "Summarize this speech" }],
        });
        expect(reads.some((read) => read.rows > 0)).toBe(true);
      }
      expect(reads.reduce((bytes, read) => bytes + read.bytes, 0)).toBeLessThan(2_048);
    },
  );
  it("stops active status descriptor reads when the public result budget is consumed", async () => {
    const { store, database } = fixture();
    for (let index = 0; index < 6; index++) {
      const target = session(`active-${index}`, {
        title: "x".repeat(READ_LIMIT / 2),
      });
      await store.writeSession(target);
      activeSessions.set(target.sessionId, {
        appends: createTranscriptCaptureAppends(() => {}),
        session: target,
        providerId: target.source.providerId,
        stopProvider: async () => {
          throw new Error("Reading transcript status must not stop capture");
        },
        releaseProvider: async () => {},
        phase: "active",
      });
    }
    const reads = observeArchiveReads(store, database());
    await expectResultTooLarge(readTranscriptLibraryStatus(store, {}));
    expect(
      reads.filter((read) => read.sql.includes('from "meeting_transcript_sessions"')).length,
    ).toBeLessThanOrEqual(3);
  });

  it.each(["text", "combined speaker fields", "source and metadata", "last timestamp"] as const)(
    "bounds %s before SQLite returns an oversized row without limiting full-store reads",
    async (field) => {
      const { store, database, get } = fixture();
      const descriptor = field === "source and metadata" || field === "last timestamp";
      const target = session("allocation");
      if (field === "source and metadata") {
        target.source.private = "x".repeat(600_000);
        target.metadata = { private: "y".repeat(600_000) };
      }
      await store.writeSession(target);
      const utterances = {
        text: () => ({ text: "é\0".repeat(READ_LIMIT / 2) }),
        "combined speaker fields": () => ({
          text: "small",
          speaker: { id: "x".repeat(600_000), label: "y".repeat(600_000) },
        }),
        "source and metadata": () => ({ text: "note" }),
        "last timestamp": () => ({ text: "note", endedAt: "x".repeat(READ_LIMIT + 1) }),
      };
      await store.appendUtteranceForSession(target, utterances[field]());
      const reads = observeArchiveReads(store, database());
      const selector = transcriptSessionSelector(target);
      if (descriptor) {
        for (const read of [
          () => listTranscriptLibrary(store, {}),
          () => store.readLatestEntry(),
          () => store.readEntry(selector),
        ]) {
          await expectResultTooLarge(read());
        }
      } else {
        await expectResultTooLarge(get(target, { includeUtterances: true, limit: 1 }), READ_LIMIT);
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every((read) => read.closed)).toBe(true);
      }
      expectRowBound(reads);
      if (descriptor) {
        expect(await store.readEntry(target.sessionId)).toBeUndefined();
        expect(await store.readSession(target.sessionId)).toEqual(target);
      } else {
        expect(await store.readUtterancesForSession(target)).toHaveLength(1);
      }
    },
  );

  it("stops a cumulative page before consuming the remaining rows and releases its iterator", async () => {
    const { store, database, get, target, selector } = await captured(
      "cumulative",
      Array.from({ length: 6 }, () => ({ text: "x".repeat(READ_LIMIT / 2) })),
    );
    const reads = observeArchiveReads(store, database());
    await expectResultTooLarge(get(target, { includeUtterances: true, limit: 6 }));
    const page = reads.find(
      (read) =>
        read.sql.includes("meeting_transcript_utterances") &&
        !read.sql.includes("meeting_transcript_sessions"),
    )!;
    expect(page.rows).toBeLessThanOrEqual(3);
    expect(page.bytes).toBeLessThanOrEqual(2 * READ_LIMIT);
    expect(page.closed).toBe(true);
    await store.appendUtteranceForSession(target, { text: "after rejection" });
    const recovered = await get(target, {
      includeUtterances: true,
      cursor: encodeCursor(cursorScope(["get", selector, undefined]), [5]),
    });
    expect(recovered.utterances).toMatchObject([{ text: "after rejection", sequence: 6 }]);
  });

  it.each(["list", "get"])(
    "uses oversized %s lookahead only for pagination, then rejects that requested row",
    async (kind) => {
      const { store, database } = fixture();
      const target = session(kind === "list" ? "a" : "lookahead");
      await store.writeSession(target);
      const oversized = "x".repeat(READ_LIMIT + 1);
      if (kind === "list") {
        await store.writeSession(session("b", { title: oversized }));
      } else {
        await store.appendUtteranceForSession(target, { text: "first" });
        await store.appendUtteranceForSession(target, { text: oversized });
      }
      let selector = transcriptSessionSelector(target);
      const readPage = (cursor?: string) =>
        kind === "list"
          ? listTranscriptLibrary(store, cursor ? { cursor } : { limit: 1 })
          : getTranscriptLibrary(store, {
              selector,
              includeUtterances: true,
              limit: 1,
              cursor,
            });
      const reads = observeArchiveReads(store, database());
      const page = await readPage();
      if ("sessions" in page) {
        expect(page.sessions.map((entry) => entry.sessionId)).toEqual(["a"]);
      } else {
        expect(page.utterances).toEqual([{ sequence: 0, text: "first" }]);
        selector = page.session.selector;
      }
      expect(page.nextCursor).not.toBeNull();
      expectRowBound(reads);
      await expectResultTooLarge(readPage(page.nextCursor!));
      if (kind === "list") {
        for (const id of ["b", "c", "d"]) {
          await store.writeSession(session(id, { title: "x".repeat(600_000) }));
        }
        reads.length = 0;
        await expectResultTooLarge(listTranscriptLibrary(store, { query: "x" }));
        expect(reads[0]?.rows).toBe(2);
        expect(reads.every((read) => read.closed)).toBe(true);
        for (const id of ["b", "c", "d"]) {
          await store.writeSession(session(id, { metadata: { private: "x".repeat(600_000) } }));
        }
        expect(
          (await listTranscriptLibrary(store, {})).sessions.map((entry) => entry.sessionId),
        ).toEqual(["a", "b", "c", "d"]);
      }
    },
  );

  it("budgets public previews after projection while retaining raw tool bounds", async () => {
    const { store, database } = fixture();
    for (const id of ["a", "b", "c"]) {
      const target = session(id, {
        source: { providerId: "manual-transcript", private: "synthetic-private" },
        metadata: { private: "synthetic-metadata", agentId: "main" },
      });
      await store.writeSession(target);
      await store.writeSummary(
        {
          ...summarizeTranscripts({ session: target, utterances: [] }),
          overview: "x".repeat(600_000),
        },
        target,
      );
    }
    const reads = observeArchiveReads(store, database());
    const page = await listTranscriptLibrary(store, { limit: 2 });
    expect(page.sessions.map(({ overview }) => overview)).toEqual([
      "x".repeat(280),
      "x".repeat(280),
    ]);
    expect(page.nextCursor).not.toBeNull();
    expect(JSON.stringify(page)).not.toContain("synthetic-");
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ executions: 1, rows: 3, closed: true });
    await expectResultTooLarge(store.listReadEntries({ limit: 2 }));
    await expectResultTooLarge(
      listTranscriptLibrary(store, { limit: 1 }, () => "x".repeat(READ_LIMIT)),
    );
  });

  it("bounds summary transfer after omitting duplicated history and keeps the larger export budget", async () => {
    const { store, database, get, download, target } = await captured("summary-bound", [
      { text: "saved note" },
    ]);
    const summary = {
      ...summarizeTranscripts({ session: target, utterances: [] }),
      transcript: ["x".repeat(EXPORT_LIMIT + 1)],
    };
    await store.writeSummary({ ...summary, transcript: [] }, target);
    const db = database();
    const summaryJson = JSON.stringify(summary);
    updateSummary(db, target, {
      summary_json: summaryJson,
      ...deriveMeetingTranscriptSummaryColumns(summaryJson),
    });
    const reads = observeArchiveReads(store, database());
    expect((await get(target)).summary?.overview).toBe(summary.overview);
    expectRowBound(reads);
    await store.writeSummary(
      { ...summary, transcript: [], overview: "é".repeat(READ_LIMIT / 2 + 1) },
      target,
    );
    reads.length = 0;
    await expectResultTooLarge(get(target, { limit: 50 }));
    expectRowBound(reads);
    const legacy = await get(target);
    expect(Buffer.byteLength(JSON.stringify(legacy))).toBeGreaterThan(READ_LIMIT);
    expect(legacy.summary?.overview).toBe("é".repeat(READ_LIMIT / 2 + 1));
    const exported = await download(target, "markdown");
    expectExportSize(exported);
    expect(Buffer.from(exported.data, "base64").toString("utf8")).toContain("saved note");
  });

  it("keeps exact JSON escaping checks and exports valid content above the reader limit", async () => {
    const text = '"'.repeat(600_000) + "é🦞";
    const { store, database, get, download, target } = await captured("escaping", [{ text }]);
    const reads = observeArchiveReads(store, database());
    await expectResultTooLarge(get(target, { includeUtterances: true, limit: 1 }));
    const exported = await download(target, "jsonl");
    expectExportSize(exported);
    expect(JSON.parse(Buffer.from(exported.data, "base64").toString("utf8"))).toEqual({
      sequence: 0,
      text,
    });
    await store.appendUtteranceForSession(target, {
      text: "x".repeat(EXPORT_LIMIT + 1),
    });
    reads.length = 0;
    await expectExportTooLarge(download(target, "jsonl"));
    expectRowBound(reads, EXPORT_LIMIT);
    expect(reads.every((read) => read.closed)).toBe(true);
  });
});
