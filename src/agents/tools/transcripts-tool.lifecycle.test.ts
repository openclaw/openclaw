import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { activeSessions } from "../../transcripts/capture-startup.js";
import { startTranscripts } from "../../transcripts/capture.js";
import type { TranscriptStartRequest } from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { summarizeTranscripts } from "../../transcripts/summary.js";
import { createEnteredGate as captureGate } from "../entered-gate.test-support.js";
import {
  captureFixture,
  type CaptureStart,
} from "./transcripts-tool.capture-fixture.test-support.js";
import {
  registerTranscriptTestProvider,
  useTranscriptTestState,
} from "./transcripts-tool.test-support.js";

const testState = useTranscriptTestState();

function pause<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
  after = false,
) {
  const gate = captureGate();
  return {
    ...gate,
    run: async (...args: Args) => {
      if (after) {
        const result = await operation(...args);
        await gate.wait();
        return result;
      }
      await gate.wait();
      return operation(...args);
    },
  };
}

function fakeDates() {
  const realNow = Date.now.bind(Date);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(Date, "now").mockImplementation(realNow);
}

function harness() {
  const f = captureFixture(
    testState(),
    {},
    {
      config: { transcripts: { enabled: true } },
      agentId: "research",
    },
  );
  const { provider, store, execute, session } = f;
  registerTranscriptTestProvider(provider);
  const caller = () => {
    let active = true;
    return {
      tool: f.tool({
        assertCallerActive: () => {
          if (!active) {
            throw new Error("caller ended");
          }
        },
      }),
      close: () => {
        active = false;
      },
    };
  };
  const start = () =>
    execute({
      action: "start",
      providerId: provider.id,
      sessionId: "notes",
      accountId: "admitted",
      meetingUrl: "https://meeting.example/room?private=opaque#fragment",
    });
  const reopen = (
    existingSession: Awaited<ReturnType<typeof session>>,
    agentId?: string,
    title?: string,
  ) =>
    startTranscripts({
      ctx: { stateDir: f.ctx.stateDir, logger: f.logger, agentId },
      store,
      rawParams: { providerId: provider.id, title },
      configuredLifecycle: true,
      existingSession,
    });
  return { ...f, caller, start, reopen };
}

it.each(["summarize", "show"] as const)(
  "does not adopt a replacement revision after a delayed %s match",
  async (action) => {
    const h = harness();
    await h.start();
    await h.action("stop");
    const original = await h.session();
    const match = pause(h.store.matchSessionEntries.bind(h.store), true);
    vi.spyOn(TranscriptsStore.prototype, "matchSessionEntries").mockImplementationOnce(match.run);
    const pending = h.action(action);
    const replacement = {
      ...original,
      title: "Replacement capture",
      source: { ...original.source, accountId: "replacement-account" },
      metadata: { ...original.metadata, agentId: "replacement-agent" },
    };
    const utterance = { text: "replacement-only note" };
    const summary = summarizeTranscripts({ session: replacement, utterances: [utterance] });
    try {
      await Promise.race([match.entered, pending]);
      await h.store.writeSession(replacement);
      await h.store.appendUtteranceForSession(replacement, utterance);
      await h.store.writeSummary(summary, replacement);
    } finally {
      match.release();
    }
    const result = await pending;
    expect(result).toMatchObject({ details: { skipped: true } });
    expect(JSON.stringify(result)).not.toContain(utterance.text);
    expect(await h.session()).toEqual(replacement);
    expect((await h.store.readSummary(replacement)).summary).toEqual(summary);
    expect(await h.store.readUtterancesForSession(replacement)).toMatchObject([utterance]);
  },
);

it.each(["selection-read", "summary-write", "stop-policy"] as const)(
  "rejects a closed caller at %s",
  async (boundary) => {
    const h = harness();
    await h.start();
    const session = await h.session();
    const caller = h.caller();
    let boundaryPause;
    if (boundary === "selection-read") {
      const read = pause(h.store.matchSessionEntries.bind(h.store), true);
      vi.spyOn(TranscriptsStore.prototype, "matchSessionEntries").mockImplementationOnce(read.run);
      boundaryPause = read;
    } else if (boundary === "summary-write") {
      const write = pause(h.store.writeSummary.bind(h.store));
      vi.spyOn(TranscriptsStore.prototype, "writeSummary").mockImplementationOnce(write.run);
      boundaryPause = write;
    } else {
      const authorization = pause(async () => ({ ok: true as const, value: undefined }));
      h.provider.accessControl = {
        channelId: "capture-channel",
        resolveAccountId: ({ source }) => ({ ok: true, value: source.accountId }),
        authorize: authorization.run,
      };
      boundaryPause = authorization;
    }
    const pending = caller.tool.execute("closing-summary", {
      action: boundary === "stop-policy" ? "stop" : "summarize",
      ...(boundary === "stop-policy"
        ? { selector: `${session.startedAt.slice(0, 10)}/notes` }
        : { sessionId: "notes" }),
    });
    const rejected = expect(pending).rejects.toThrow(
      boundary === "stop-policy" ? undefined : "caller ended",
    );
    try {
      await Promise.race([boundaryPause.entered, pending]);
      caller.close();
    } finally {
      boundaryPause.release();
      await rejected;
    }
    expect(await h.store.readSummary(session)).toEqual({});
    expect(h.provider.stop).not.toHaveBeenCalled();
    expect((await h.session()).stoppedAt).toBeUndefined();
    if (boundary !== "stop-policy") {
      await h.action("stop");
    }
  },
);

it("does not grant retry authority when failed startup cannot restore its session", async () => {
  const h = harness();
  await h.start();
  await h.requests[0]!.onUtterance({ text: "Original note" });
  await h.action("stop");
  const existingSession = await h.session();
  const originalWrite = h.store.writeSession.bind(h.store);
  vi.spyOn(h.store, "writeSession")
    .mockImplementationOnce(originalWrite)
    .mockRejectedValueOnce(new Error("restore unavailable"));
  h.provider.start = vi.fn<CaptureStart>(async () => ({
    ok: false,
    error: "provider unavailable",
  }));
  await expect(h.reopen(existingSession)).rejects.toMatchObject({
    name: "TranscriptStartError",
    code: "admitted-start-failed",
    retry: undefined,
  });
  expect(h.provider.start).toHaveBeenCalledOnce();
  expect(await h.store.listSessionEntries()).toHaveLength(1);
  expect(await h.store.readUtterancesForSession(existingSession)).toMatchObject([
    { text: "Original note" },
  ]);
  await h.action("stop");
});

it("releases the provider when shutdown interrupts title adoption", async () => {
  const h = harness();
  const gate = captureGate();
  const controller = new AbortController();
  h.provider.start = async (request) => ({
    ok: true,
    session: { ...request.session, title: "Room" },
  });
  const originalWrite = h.store.writeSession.bind(h.store);
  let blocked = false;
  vi.spyOn(TranscriptsStore.prototype, "writeSession").mockImplementation(
    async (session, condition) => {
      if (session.title === "Room" && !blocked) {
        blocked = true;
        await gate.wait();
      }
      return originalWrite(session, condition);
    },
  );
  const start = h.execute(
    { action: "start", providerId: "capture", sessionId: "notes" },
    controller.signal,
  );
  const rejected = expect(start).rejects.toThrow("aborted");
  try {
    await gate.entered;
    controller.abort();
  } finally {
    gate.release();
  }
  await rejected;
  expect(h.provider.stop).toHaveBeenCalledOnce();
  expect((await h.session()).stoppedAt).toBeDefined();
  expect(await h.store.readSummary(await h.session())).toMatchObject({
    summary: { utteranceCount: 0 },
  });
  expect(activeSessions.has("notes")).toBe(false);
});

it.each([false, true])(
  "bounds fresh provider titles and preserves an absent admitted title (reopen=%s)",
  async (reopen) => {
    const h = harness();
    let existingSession: Awaited<ReturnType<typeof h.store.readSession>>;
    if (reopen) {
      await h.execute({ action: "start", providerId: "capture" });
      const initial = h.requests[0]!.session;
      await h.action("stop", initial.sessionId);
      existingSession = await h.store.readSession(initial.sessionId);
    }
    h.provider.start = async (request) => {
      if (request.session.metadata) {
        request.session.metadata.sessionIdOrigin = "forged";
      }
      return {
        ok: true,
        session: {
          ...request.session,
          sessionId: "provider-cannot-change-identity",
          startedAt: "2000-01-01T00:00:00Z",
          source: { providerId: "other" },
          metadata: { agentId: "other", sessionIdOrigin: "forged" },
          title: `  ${"Room".repeat(40)}  `,
        },
      };
    };
    const sessionId = existingSession?.sessionId ?? "notes";
    if (existingSession) {
      await h.reopen(existingSession, "research", "Future title");
    } else {
      await h.execute({ action: "start", providerId: "capture", sessionId });
    }
    const stored = await h.store.readSession(sessionId);
    expect(stored?.title).toBe(reopen ? undefined : "Room".repeat(30));
    expect(stored).toMatchObject({
      sessionId,
      source: { providerId: "capture" },
      metadata: { agentId: "research", sessionIdOrigin: reopen ? "generated" : "supplied" },
    });
    expect(stored?.startedAt).not.toBe("2000-01-01T00:00:00Z");
    await h.action("stop", sessionId);
  },
);

it.each(["terminal", "rejected"] as const)(
  "fences old callbacks after a %s startup",
  async (outcome) => {
    fakeDates();
    vi.setSystemTime(new Date("2026-07-01T10:00:00.000Z"));
    const h = harness();
    let retained!: TranscriptStartRequest;
    h.provider.start = async (request) => {
      retained = request;
      await request.onUtterance({ text: "before closure" });
      await request.onStatus?.({
        active: false,
        sessionId: "another-id",
        source: { providerId: "other", accountId: "other" },
      });
      await request.onStatus?.({ active: true });
      await request.onUtterance({ text: "after closure" });
      return outcome === "rejected"
        ? { ok: false, error: "start failed" }
        : {
            ok: true,
            session: {
              ...request.session,
              source: { providerId: "other" },
              metadata: { agentId: "other" },
            },
          };
    };
    if (outcome === "terminal") {
      await expect(h.start()).resolves.toMatchObject({
        details: {
          sessionId: "notes",
          selector: `${new Date().toISOString().slice(0, 10)}/notes`,
          active: false,
          stoppedAt: expect.any(String),
        },
      });
      expect(await h.store.readSummary(await h.session())).toMatchObject({
        summary: { utteranceCount: 1 },
      });
      await expect(fs.stat(h.store.sessionDir(await h.session()))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } else {
      await expect(h.start()).rejects.toThrow("start failed");
    }
    await h.status([]);
    const first = await h.session();
    expect(first).toMatchObject({
      source: {
        providerId: "capture",
        accountId: "admitted",
        agentId: "research",
        meetingUrl: "https://meeting.example/room",
      },
      metadata: { agentId: "research" },
    });
    h.provider.start = async (request) => ({ ok: true, session: request.session });
    vi.setSystemTime(new Date("2026-07-02T10:00:00.000Z"));
    await h.start();
    await retained.onStatus?.({ active: false, sessionId: "notes" });
    await retained.onUtterance({ text: "stale callback after reuse" });
    const replacement = (await h.store.readSession("2026-07-02/notes"))!;
    expect(replacement.startedAt).toBe("2026-07-02T10:00:00.000Z");
    expect(replacement.stoppedAt).toBeUndefined();
    expect(await h.store.readUtterancesForSession(replacement)).toEqual([]);
    expect((await h.store.readUtterancesForSession(first)).map((row) => row.text)).toEqual([
      "before closure",
    ]);
    await h.status([{ sessionId: "notes" }]);
    expect(h.provider.stop).not.toHaveBeenCalled();
    const summaryPath = path.join(h.store.sessionDir(replacement), "summary.md");
    await expect(h.action("stop")).resolves.toMatchObject({
      details: { summaryPath },
    });
    expect((await fs.stat(summaryPath)).isFile()).toBe(true);
  },
);

it("does not overwrite final notes with an older summary while stop exports them", async () => {
  const h = harness();
  await h.start();
  const session = await h.session();
  await h.requests[0]!.onUtterance({ text: "Before summary" });
  const read = pause(h.store.readSummarySnapshot.bind(h.store), true);
  const exported = pause(h.store.materializeSessionArtifacts.bind(h.store));
  vi.spyOn(TranscriptsStore.prototype, "readSummarySnapshot").mockImplementationOnce(read.run);
  const summary = h.action("summarize");
  let stop: ReturnType<typeof h.execute> | undefined;
  try {
    await read.entered;
    await h.requests[0]!.onUtterance({ text: "Before stop" });
    vi.spyOn(TranscriptsStore.prototype, "materializeSessionArtifacts").mockImplementationOnce(
      exported.run,
    );
    stop = h.action("stop");
    await vi.waitFor(() => expect(h.provider.stop).toHaveBeenCalledOnce());
    read.release();
    await exported.entered;
    await expect(summary).resolves.toMatchObject({ details: { skipped: true } });
    expect(await h.store.readSummary(session)).toMatchObject({
      summary: { transcript: ["Before summary", "Before stop"] },
    });
  } finally {
    read.release();
    exported.release();
    await Promise.allSettled([summary, stop]);
  }
});

it.each([
  { action: "stop", key: "selector" },
  { action: "summarize", key: "sessionId" },
  { action: "status", key: "sessionId" },
] as const)(
  "revalidates capture identity after awaited $action authorization via $key without reusing startup authority",
  async ({ action, key }) => {
    fakeDates();
    vi.setSystemTime(new Date("2026-07-01T10:00:00.000Z"));
    const h = harness();
    const caller = h.caller();
    const authorization = captureGate();
    let delayAuthorization = true;
    h.provider.accessControl = {
      channelId: "capture-channel",
      resolveAccountId: ({ source }) => ({ ok: true, value: source.accountId }),
      authorize: async (request) => {
        if (request.action === action && delayAuthorization) {
          delayAuthorization = false;
          await authorization.wait();
        }
        return { ok: true, value: undefined };
      },
    };
    await caller.tool.execute("start", {
      action: "start",
      providerId: "capture",
      sessionId: "notes",
    });
    const delayed = h.execute({
      action,
      ...(action !== "status"
        ? {
            [key]: key === "selector" ? `${new Date().toISOString().slice(0, 10)}/notes` : "notes",
          }
        : {}),
    });
    await Promise.race([authorization.entered, delayed]);
    caller.close();
    await h.requests[0]!.onStatus?.({ active: false });
    vi.setSystemTime(new Date("2026-07-02T10:00:00.000Z"));
    await h.start();
    const replacement = (await h.store.readSession("2026-07-02/notes"))!;
    const savedSummary = await h.store.readSummary(replacement);
    authorization.release();
    await expect.soft(delayed).resolves.toMatchObject({
      details: action === "status" ? { active: [] } : { skipped: true },
    });
    expect.soft(await h.store.readSummary(replacement)).toEqual(savedSummary);
    await expect.soft(fs.stat(h.store.sessionDir(replacement))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(h.provider.stop).not.toHaveBeenCalled();
    expect((await h.store.readSession("2026-07-02/notes"))?.stoppedAt).toBeUndefined();
    await h.action("stop");
  },
);
