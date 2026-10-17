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
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { activeSessions } from "./capture-startup.js";
import { transcriptLibraryTimezoneEntrypoint } from "./library-timezone-runtime.test-support.js";
import { exportTranscriptLibrary, getTranscriptLibrary, listTranscriptLibrary } from "./library.js";
import {
  createTranscriptLibraryStoreFixture,
  transcriptLibrarySession as session,
} from "./library.store.test-support.js";
import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";
import { deriveMeetingTranscriptSummaryColumns } from "./store-columns.js";
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

function fixture() {
  const context = createTranscriptLibraryStoreFixture(tempDirs.make("transcript-library-"));
  const { store } = context;
  return {
    ...context,
    list: (params: Parameters<typeof listTranscriptLibrary>[1] = {}) =>
      listTranscriptLibrary(store, params),
    get: (
      selector: string,
      params: Omit<Parameters<typeof getTranscriptLibrary>[1], "selector"> = {},
    ) => getTranscriptLibrary(store, { selector, ...params }),
    download: (selector: string, format: "markdown" | "jsonl") =>
      exportTranscriptLibrary(store, { selector, format }),
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
      executeSqliteQuerySync(
        db,
        meetingTranscriptDb(db)
          .updateTable("meeting_transcript_summaries")
          .set({
            markdown: notesKind === "structured-only" ? null : canonicalMarkdown,
            ...(notesKind === "markdown-only"
              ? { summary_json: null, ...deriveMeetingTranscriptSummaryColumns(null) }
              : {}),
          })
          .where("session_id", "=", target.sessionId)
          .where("session_started_at", "=", target.startedAt),
      );
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
    const { store, stateDir, get, download } = fixture();
    const target = session("large");
    await store.writeSession(target);
    const selector = transcriptSessionSelector(target);
    expect((await get(selector)).summary).toBeUndefined();
    expect(contents(await download(selector, "markdown"))).not.toContain("## Overview");
    await store.appendUtteranceForSession(target, {
      text: "x".repeat(READ_LIMIT + 1),
    });
    await expect(get(selector, { includeUtterances: true, limit: 50 })).rejects.toThrow(
      expect.objectContaining({ type: "transcript_result_too_large" }),
    );
    for (const format of ["jsonl", "markdown"] as const) {
      const exported = await download(selector, format);
      expect(exported.sizeBytes).toBeGreaterThan(READ_LIMIT);
      expect(exported.sizeBytes).toBeLessThan(EXPORT_LIMIT);
    }
    await store.appendUtteranceForSession(target, {
      text: "x".repeat(EXPORT_LIMIT),
    });
    for (const format of ["jsonl", "markdown"] as const) {
      await expect(download(selector, format)).rejects.toThrow(
        expect.objectContaining({
          type: "transcript_export_too_large",
          maxBytes: EXPORT_LIMIT,
        }),
      );
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
