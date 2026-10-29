import assert from "node:assert/strict";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { applySkillEnvOverridesFromSnapshot } from "../../skills/runtime/env-overrides.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { createTranscriptCaptureAppends } from "../../transcripts/capture-appends.js";
import { activeSessions } from "../../transcripts/capture-startup.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptSourceProvider,
} from "../../transcripts/provider-types.js";
import { type TranscriptsStore, transcriptSessionSelector } from "../../transcripts/store.js";
import { summarizeTranscripts } from "../../transcripts/summary.js";
import { createTranscriptsTool } from "./transcripts-tool.js";
import { useTranscriptTestState } from "./transcripts-tool.test-support.js";

const { getProvider } = vi.hoisted(() => ({ getProvider: vi.fn() }));
vi.mock("../../transcripts/provider-registry.js", () => ({
  getTranscriptSourceProvider: getProvider,
  listTranscriptSourceProviders: () => [],
}));
const testState = useTranscriptTestState();
let stateDir: string;
let store: TranscriptsStore;
const session = {
  sessionId: "meeting",
  title: "Weekly review",
  startedAt: "2026-08-02T14:00:00.000Z",
  source: { providerId: "voice", guildId: "team" },
  metadata: { agentId: "capture-agent" },
};
const selector = transcriptSessionSelector(session);
const foreignSource = { providerId: "voice", guildId: "other" };
type Authorize = NonNullable<TranscriptSourceProvider["accessControl"]>["authorize"];
function provider(authorize: Authorize) {
  const accessControl = { channelId: "discord", authorize };
  getProvider.mockReturnValue({ id: "voice", name: "Voice", accessControl });
}
function writeNotes(text: string, descriptor = session) {
  return store.writeSummary(
    summarizeTranscripts({ session: descriptor, utterances: [{ text }] }),
    descriptor,
  );
}
function saveSession(overrides: Partial<TranscriptSessionDescriptor>) {
  return store.writeSession({ ...session, ...overrides });
}
function show(channel = false) {
  return run({ action: "show", selector }, channel);
}
async function expectList(sessions: unknown[], channel = false, limit = 2) {
  expect((await run({ action: "list", limit }, channel)).details).toMatchObject({ sessions });
}
function registerActiveCapture() {
  activeSessions.set(session.sessionId, {
    appends: createTranscriptCaptureAppends(() => {}),
    session,
    providerId: session.source.providerId,
    stopProvider: async () => {
      throw new Error("Reading notes must not stop capture");
    },
    releaseProvider: async () => {},
    phase: "active",
  });
}

function run(params: Record<string, unknown>, channel = false) {
  return createTranscriptsTool({
    agentId: "reader-agent",
    caller: channel
      ? { kind: "channel", channel: "discord", senderId: "reader", groupSpace: "team", roleIds: [] }
      : { kind: "operator", source: "local" },
  }).execute("read", params);
}
function expectNotes(result: Awaited<ReturnType<typeof run>>, text: string) {
  expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(text) }]);
}

beforeEach(async () => {
  ({ stateDir, store } = testState());
  getProvider.mockReset();
  await store.writeSession(session);
});

describe("transcripts read actions", () => {
  it("retains write-time chronology when a skill changes the warm worker timezone", async () => {
    const expected = [{ sessionId: "late" }, { sessionId: "early" }];
    let releaseSkill = () => {};
    try {
      for (const [sessionId, hour] of [
        ["early", "06"],
        ["late", "09"],
      ] as const) {
        await store.writeSession({ ...session, sessionId, startedAt: `2026-08-20T${hour}:00:00Z` });
      }
      await expectList(expected);
      releaseSkill = applySkillEnvOverridesFromSnapshot({
        snapshot: { prompt: "", skills: [{ name: "chronology" }] },
        config: { skills: { entries: { chronology: { env: { TZ: "Pacific/Honolulu" } } } } },
      });
      expect(process.env.TZ).toBe("Pacific/Honolulu");
      await expectList(expected);
      const pending = store.listReadEntries({ limit: 2 });
      releaseSkill();
      releaseSkill = () => {};
      const ordered = (await pending).entries.map(({ session: { sessionId } }) => ({ sessionId }));
      expect(ordered).toEqual(expected);
      await expectList(expected);
    } finally {
      releaseSkill();
      vi.unstubAllEnvs();
    }
  });

  it("rejects notes rewritten while active source authorization is pending", async () => {
    await writeNotes("Authorized notes");
    registerActiveCapture();
    const entered = createDeferred();
    const release = createDeferred();
    const authorize = vi.fn<Authorize>(async ({ source }) => {
      if (source.guildId !== "team") {
        return { ok: false, error: "denied" };
      }
      entered.resolve();
      await release.promise;
      return { ok: true, value: undefined };
    });
    provider(authorize);
    const params = { action: "show", selector };
    const reading = run(params, true);
    try {
      await Promise.race([entered.promise, reading]);
      expect(authorize).toHaveBeenCalledOnce();
      const rewritten = { ...session, source: foreignSource };
      await store.writeSession(rewritten);
      await writeNotes("Other guild notes", rewritten);
      release.resolve();
      const shown = await reading;
      expect(shown.details).toMatchObject({
        sessionId: session.sessionId,
        selector: params.selector,
        skipped: true,
        retryable: true,
        text: expect.stringContaining("Retry show"),
      });
      expect(JSON.stringify(shown)).not.toContain("Other guild notes");
      await expect(run(params, true)).rejects.toThrow("session not found");
      expect(await store.readSession(params.selector)).toEqual(rewritten);
    } finally {
      release.resolve();
      await reading.catch(() => undefined);
    }
  });

  it("reads across agent ownership without widening mutation authority", async () => {
    await store.appendUtteranceForSession(session, {
      text: "Ship the design",
      speaker: { label: "Ada" },
    });
    await writeNotes("Ship the design");
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const sql = observeMainThreadSql();
    try {
      const listed = await run({ action: "list" });
      expect(listed.details).toMatchObject({
        sessions: [{ sessionId: "meeting", participants: ["Ada"], utteranceCount: 1 }],
      });
      expect(listed.details).not.toHaveProperty("sessions.0.overview");
      expectNotes(await show(), "Ship the design");
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    await expect(run({ action: "stop", selector })).rejects.toThrow("not found");
  });

  it("passes read actions to provider policy and hides unauthorized meetings", async () => {
    const authorize = vi.fn<Authorize>(async ({ source, caller }) =>
      caller.kind === "channel" && source.guildId === caller.groupSpace
        ? { ok: true, value: undefined }
        : { ok: false, error: "denied" },
    );
    provider(authorize);
    const metadata = { providerPrivate: "x".repeat(600_000) };
    for (const sessionId of ["hidden", "hidden-too"]) {
      await saveSession({ sessionId, source: foreignSource, metadata });
    }
    await expectList([{ sessionId: "meeting" }], true, 1);
    await show(true);
    expect(authorize.mock.calls.map(([arg]) => arg.action)).toContain("show");
    await expect(run({ action: "show", sessionId: "hidden" }, true)).rejects.toThrow("not found");
    getProvider.mockReturnValue({ id: "voice", name: "Uncontrolled provider" });
    expect((await run({ action: "list" }, true)).details).toEqual({ sessions: [] });
  });

  it("authorizes durable notes rather than a live capture's retained source", async () => {
    const authorize = vi.fn<Authorize>(async ({ source }) =>
      source.guildId === "team" ? { ok: true, value: undefined } : { ok: false, error: "denied" },
    );
    provider(authorize);
    registerActiveCapture();
    await saveSession({ source: foreignSource });
    await writeNotes("Other guild notes");
    const authorizedSource = expect.objectContaining({ action: "show", source: foreignSource });
    await expect(show(true)).rejects.toThrow("not found");
    expect(authorize).toHaveBeenLastCalledWith(authorizedSource);
    authorize.mockResolvedValue({ ok: true, value: undefined });
    expectNotes(await run({ action: "show", sessionId: "meeting" }, true), "Other guild notes");
    expect(authorize).toHaveBeenLastCalledWith(authorizedSource);
  });

  it("closes its read page before awaited source authorization writes and checkpoints state", async () => {
    const text = "Written during authorization";
    provider(async () => {
      await store.appendUtteranceForSession(session, { text });
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const { db } = openOpenClawStateDatabase({ env });
      // A pending SELECT would prevent the provider's committed write from checkpointing.
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      return { ok: true, value: undefined };
    });
    await expectList([{ sessionId: session.sessionId, utteranceCount: 0 }], true, 1);
    expect(await store.readUtterancesForSession(session)).toMatchObject([{ text }]);
  });

  it("bounds model-facing notes and reports active captures without summaries", async () => {
    registerActiveCapture();
    expect((await run({ action: "show", sessionId: "meeting" })).details).toMatchObject({
      active: true,
      text: "No summary exists yet for this meeting. Capture is active.",
    });
    await store.writeSummary(
      { ...summarizeTranscripts({ session, utterances: [] }), overview: "x".repeat(20000) },
      session,
    );
    const shown = await run({ action: "show", sessionId: "meeting" });
    const text = shown.content[0];
    assert(text?.type === "text", "missing notes text");
    expect(text.text.length).toBeLessThanOrEqual(12000);
    expect(text.text).toContain(
      `[truncated; run openclaw transcripts show ${selector} for the full notes]`,
    );
    expect(shown.details).toMatchObject({ text: text.text });
    for (let index = 0; index < 50; index++) {
      await saveSession({ sessionId: `meeting-${index}`, title: "Long title ".repeat(40) });
    }
    const listed = await run({ action: "list", limit: 50 });
    expect(listed.details).toHaveProperty("sessions.length", 50);
    expect(JSON.stringify(listed.content).length).toBeLessThan(4200);
  });
});
