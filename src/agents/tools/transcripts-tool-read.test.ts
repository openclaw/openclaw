import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { applySkillEnvOverridesFromSnapshot } from "../../skills/runtime/env-overrides.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createTranscriptCaptureAppends } from "../../transcripts/capture-appends.js";
import { activeSessions } from "../../transcripts/capture.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptSourceProvider,
} from "../../transcripts/provider-types.js";
import { TranscriptsStore, transcriptSessionSelector } from "../../transcripts/store.js";
import { summarizeTranscripts } from "../../transcripts/summary.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
} from "../tool-search-catalog.js";
import { resolveToolSearchConfig } from "../tool-search-config.js";
import { ToolSearchRuntime } from "../tool-search-runtime.js";
import { createTranscriptsTool } from "./transcripts-tool.js";

const { getProvider } = vi.hoisted(() => ({ getProvider: vi.fn() }));
vi.mock("../../transcripts/provider-registry.js", () => ({
  getTranscriptSourceProvider: getProvider,
  listTranscriptSourceProviders: () => [],
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
let store: TranscriptsStore;
const session = {
  sessionId: "meeting",
  title: "Weekly review",
  startedAt: "2026-08-02T14:00:00.000Z",
  source: { providerId: "voice", guildId: "team" },
  metadata: { agentId: "capture-agent" },
};
function registerActiveCapture(descriptor: TranscriptSessionDescriptor = session) {
  activeSessions.set(descriptor.sessionId, {
    appends: createTranscriptCaptureAppends(() => {}),
    session: descriptor,
    providerId: descriptor.source.providerId,
    stopProvider: async () => {
      throw new Error("Reading notes must not stop capture");
    },
    releaseProvider: async () => {},
    phase: "active",
  });
}

function tool(channel = false) {
  return createTranscriptsTool({
    stateDir,
    agentId: "reader-agent",
    caller: channel
      ? { kind: "channel", channel: "discord", senderId: "reader", groupSpace: "team", roleIds: [] }
      : { kind: "operator", source: "local" },
  });
}
function run(params: Record<string, unknown>, channel = false) {
  return tool(channel).execute("read", params);
}
function readThroughCatalog(params: Record<string, unknown>) {
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [tool()] });
  const runtime = new ToolSearchRuntime({ catalogRef }, resolveToolSearchConfig(), {
    validateInput: true,
  });
  return runtime.callValue("transcripts", params);
}

beforeEach(async () => {
  stateDir = tempDirs.make("transcripts-read-");
  store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  getProvider.mockReset();
  await store.writeSession(session);
});
afterEach(async () => {
  activeSessions.clear();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

describe("transcripts read actions", () => {
  it("uses the active skill timezone after the database worker is already warm", async () => {
    vi.stubEnv("TZ", undefined);
    const local = { ...session, sessionId: "local", startedAt: "2026-08-20T06:00:00" };
    const explicit = { ...session, sessionId: "explicit", startedAt: "2026-08-20T09:00:00Z" };
    let releaseSkill = () => {};
    const expected = () =>
      [local, explicit]
        .toSorted((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
        .map(({ sessionId }) => ({ sessionId }));
    try {
      await store.writeSession(local);
      await store.writeSession(explicit);
      const original = expected();
      expect((await run({ action: "list", limit: 2 })).details).toMatchObject({
        sessions: original,
      });
      const timezone = original[0]?.sessionId === "local" ? "UTC" : "Pacific/Honolulu";
      releaseSkill = applySkillEnvOverridesFromSnapshot({
        snapshot: { prompt: "", skills: [{ name: "chronology" }] },
        config: { skills: { entries: { chronology: { env: { TZ: timezone } } } } },
      });
      expect(process.env.TZ).toBe(timezone);
      expect(expected()).not.toEqual(original);
      expect((await run({ action: "list", limit: 2 })).details).toMatchObject({
        sessions: expected(),
      });
      const pending = store.listReadEntries({ limit: 2 });
      releaseSkill();
      releaseSkill = () => {};
      await expect(pending).rejects.toThrow("Transcript timezone changed while reading");
      expect((await run({ action: "list", limit: 2 })).details).toMatchObject({
        sessions: original,
      });
    } finally {
      releaseSkill();
      vi.unstubAllEnvs();
    }
  });

  it.each(["active", "stopped"] as const)(
    "rejects notes rewritten while %s source authorization is pending",
    async (state) => {
      const descriptor = {
        ...session,
        ...(state === "stopped" ? { stoppedAt: "2026-08-02T15:00:00.000Z" } : {}),
      };
      await store.writeSession(descriptor);
      await store.writeSummary(
        summarizeTranscripts({ session: descriptor, utterances: [{ text: "Authorized notes" }] }),
        descriptor,
      );
      if (state === "active") {
        registerActiveCapture(descriptor);
      }
      const entered = createDeferred();
      const release = createDeferred();
      const authorize = vi.fn<NonNullable<TranscriptSourceProvider["accessControl"]>["authorize"]>(
        async ({ source }) => {
          if (source.guildId !== "team") {
            return { ok: false, error: "denied" };
          }
          entered.resolve();
          await release.promise;
          return { ok: true, value: undefined };
        },
      );
      getProvider.mockReturnValue({
        id: "voice",
        accessControl: { channelId: "discord", authorize },
      });
      const params = { action: "show", selector: transcriptSessionSelector(descriptor) };
      const reading = run(params, true);
      try {
        await Promise.race([entered.promise, reading]);
        expect(authorize).toHaveBeenCalledOnce();
        const rewritten = { ...descriptor, source: { providerId: "voice", guildId: "other" } };
        await store.writeSession(rewritten);
        await store.writeSummary(
          summarizeTranscripts({ session: rewritten, utterances: [{ text: "Other guild notes" }] }),
          rewritten,
        );
        release.resolve();
        const shown = await reading;
        expect(shown.details).toMatchObject({
          sessionId: descriptor.sessionId,
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
    },
  );

  it("reads across agent ownership without widening mutation authority", async () => {
    await store.appendUtteranceForSession(session, {
      text: "Ship the design",
      speaker: { label: "Ada" },
    });
    await store.writeSummary(
      summarizeTranscripts({ session, utterances: [{ text: "Ship the design" }] }),
      session,
    );
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const parentCalls = [
      vi.spyOn(DatabaseSync.prototype, "prepare"),
      vi.spyOn(DatabaseSync.prototype, "exec"),
      ...(["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      ),
    ];
    try {
      const listed = await run({ action: "list" });
      expect(listed.details).toMatchObject({
        sessions: [{ sessionId: "meeting", participants: ["Ada"], utteranceCount: 1 }],
      });
      expect(listed.details).not.toHaveProperty("sessions.0.overview");
      const shown = await run({ action: "show", selector: transcriptSessionSelector(session) });
      expect(shown.content).toEqual([
        { type: "text", text: expect.stringContaining("Ship the design") },
      ]);
      for (const calls of parentCalls) {
        expect(calls.mock.calls, "caller-thread SQLite activity during list/show").toHaveLength(0);
      }
    } finally {
      for (const calls of parentCalls) {
        calls.mockRestore();
      }
    }
    await expect(
      run({ action: "stop", selector: transcriptSessionSelector(session) }),
    ).rejects.toThrow("not found");
  });

  it("passes read actions to provider policy and hides unauthorized meetings", async () => {
    const authorize = vi.fn<NonNullable<TranscriptSourceProvider["accessControl"]>["authorize"]>(
      async ({ source, caller }) =>
        caller.kind === "channel" && source.guildId === caller.groupSpace
          ? { ok: true, value: undefined }
          : { ok: false, error: "denied" },
    );
    getProvider.mockReturnValue({
      id: "voice",
      name: "Voice",
      accessControl: { channelId: "discord", authorize },
    });
    for (const sessionId of ["hidden", "hidden-too"]) {
      await store.writeSession({
        ...session,
        sessionId,
        source: { providerId: "voice", guildId: "other" },
        metadata: { providerPrivate: "x".repeat(600_000) },
      });
    }
    expect((await run({ action: "list", limit: 1 }, true)).details).toMatchObject({
      sessions: [{ sessionId: "meeting" }],
    });
    await run({ action: "show", selector: transcriptSessionSelector(session) }, true);
    expect(authorize.mock.calls.map(([arg]) => arg.action)).toContain("show");
    await expect(run({ action: "show", sessionId: "hidden" }, true)).rejects.toThrow("not found");
    getProvider.mockReturnValue({ id: "voice", name: "Uncontrolled provider" });
    expect((await run({ action: "list" }, true)).details).toEqual({ sessions: [] });
  });

  it("authorizes durable notes rather than a live capture's retained source", async () => {
    const authorize = vi.fn<NonNullable<TranscriptSourceProvider["accessControl"]>["authorize"]>(
      async ({ source }) =>
        source.guildId === "team" ? { ok: true, value: undefined } : { ok: false, error: "denied" },
    );
    getProvider.mockReturnValue({
      id: "voice",
      name: "Voice",
      accessControl: {
        channelId: "discord",
        authorize,
      },
    });
    registerActiveCapture();
    await store.writeSession({ ...session, source: { providerId: "voice", guildId: "other" } });
    await store.writeSummary(
      summarizeTranscripts({ session, utterances: [{ text: "Other guild notes" }] }),
      session,
    );
    await expect(
      run({ action: "show", selector: transcriptSessionSelector(session) }, true),
    ).rejects.toThrow("not found");
    expect(authorize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "show",
        source: { providerId: "voice", guildId: "other" },
      }),
    );
    authorize.mockResolvedValue({ ok: true, value: undefined });
    const shown = await run({ action: "show", sessionId: "meeting" }, true);
    expect(shown.content).toEqual([
      { type: "text", text: expect.stringContaining("Other guild notes") },
    ]);
    expect(authorize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "show",
        source: { providerId: "voice", guildId: "other" },
      }),
    );
  });

  it("closes its read page before awaited source authorization writes and checkpoints state", async () => {
    getProvider.mockReturnValue({
      id: "voice",
      name: "Voice",
      accessControl: {
        channelId: "discord",
        authorize: async () => {
          await store.appendUtteranceForSession(session, { text: "Written during authorization" });
          const { db } = openOpenClawStateDatabase({
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          });
          // A pending SELECT would prevent the provider's committed write from checkpointing.
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          return { ok: true, value: undefined };
        },
      },
    });
    expect((await run({ action: "list", limit: 1 }, true)).details).toMatchObject({
      sessions: [{ sessionId: session.sessionId, utteranceCount: 0 }],
    });
    expect(await store.readUtterancesForSession(session)).toMatchObject([
      { text: "Written during authorization" },
    ]);
  });

  it("bounds model-facing notes and reports active captures without summaries", async () => {
    registerActiveCapture();
    await expect(
      readThroughCatalog({ action: "show", sessionId: "meeting" }),
    ).resolves.toMatchObject({
      active: true,
      text: "No summary exists yet for this meeting. Capture is active.",
    });
    await store.writeSummary(
      { ...summarizeTranscripts({ session, utterances: [] }), overview: "x".repeat(20000) },
      session,
    );
    const shown = await run({ action: "show", sessionId: "meeting" });
    const text = shown.content[0];
    if (!text || text.type !== "text") {
      throw new Error("missing notes text");
    }
    expect(text.text.length).toBeLessThanOrEqual(12000);
    expect(text.text).toContain(
      `[truncated; run openclaw transcripts show ${transcriptSessionSelector(session)} for the full notes]`,
    );
    await expect(
      readThroughCatalog({ action: "show", sessionId: "meeting" }),
    ).resolves.toMatchObject({
      text: text.text,
    });
    for (let index = 0; index < 50; index++) {
      await store.writeSession({
        ...session,
        sessionId: `meeting-${index}`,
        title: "Long title ".repeat(40),
      });
    }
    const listed = await run({ action: "list", limit: 50 });
    expect(listed.details).toHaveProperty("sessions.length", 50);
    expect(JSON.stringify(listed.content).length).toBeLessThan(4200);
  });

  it.each([{}, { selector: "one", sessionId: "two" }])(
    "requires exactly one show selector %j",
    async (params) => {
      await expect(run({ action: "show", ...params })).rejects.toThrow("exactly one");
    },
  );
});
