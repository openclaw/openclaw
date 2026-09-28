import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTranscriptsTool } from "../agents/tools/transcripts-tool.js";
import type { MeetingSessionRecord } from "../meeting-bot/session-types.js";
import { createMeetingDurableTranscriptBridge } from "../meeting-bot/transcripts-bridge.runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import * as gatewayWorkAdmission from "../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createTranscriptsStore } from "./capture-operations.js";
import { activeSessions, startTranscripts } from "./capture.js";
import { clearTranscriptCapturesForTest } from "./capture.test-support.js";
import { getTranscriptLibrary, listTranscriptLibrary } from "./library.js";
import type { TranscriptStartRequest } from "./provider-types.js";
import { TranscriptsStore } from "./store.js";
import { summarizeTranscripts } from "./summary.js";

const { complete, select } = vi.hoisted(() => ({ complete: vi.fn(), select: vi.fn() }));
vi.mock("./summary-model.runtime.js", () => ({
  runIsolatedCompletion: complete,
  resolveSimpleCompletionSelectionForAgent: select,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fiveMinutes = 5 * 60_000;
const pendingCompletions = new Set<() => void>();
function holdCompletion() {
  const pending = createDeferred<ReturnType<typeof modelNotes>>();
  const entered = createDeferred();
  complete.mockImplementationOnce(() => {
    entered.resolve();
    return pending.promise;
  });
  pendingCompletions.add(() => pending.resolve(modelNotes()));
  return { ...pending, entered: entered.promise };
}
function trackSummaryUpdates() {
  return vi.spyOn(gatewayWorkAdmission, "runWithGatewayDetachedWorkAdmission");
}
async function settleSummaryUpdates(updates: ReturnType<typeof trackSummaryUpdates>) {
  await Promise.all(updates.mock.results.map(({ value }) => value));
  // The capture owner rearms its timer in the continuation after detached work settles.
  await vi.advanceTimersByTimeAsync(0);
}
const cfg = { agents: { defaults: { utilityModel: "test/utility", model: "test/primary" } } };
const modelNotes = () => ({
  text: JSON.stringify({
    overview: "The team chose a simpler design.",
    decisions: ["Simplify the design"],
    actionItems: [],
    risks: [],
  }),
  provider: "test",
  model: "utility",
});

beforeEach(() => {
  vi.useFakeTimers();
  complete.mockReset().mockResolvedValue(modelNotes());
  select.mockReset().mockImplementation(({ modelRef, agentId }) => ({
    provider: "test",
    modelId: modelRef.split("/")[1],
    agentDir: `/tmp/${agentId}`,
  }));
});
afterEach(async () => {
  for (const settle of pendingCompletions) {
    settle();
  }
  pendingCompletions.clear();
  await clearTranscriptCapturesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function capture(stateDir = tempDirs.make("transcript-live-notes-")) {
  const updates = trackSummaryUpdates();
  const ctx = {
    stateDir,
    config: cfg,
    logger: { warn: vi.fn() },
    caller: { kind: "operator" as const, source: "local" as const },
  };
  const store = createTranscriptsStore(ctx);
  let source!: TranscriptStartRequest;
  const stopStarted = createDeferred();
  const stop = vi.fn(async ({ sessionId }: { sessionId: string }) => {
    stopStarted.resolve();
    return { ok: true as const, sessionId };
  });
  const registry = createEmptyPluginRegistry();
  registry.transcriptSourceProviders.push({
    pluginId: "notes",
    source: import.meta.url,
    provider: {
      id: "notes",
      name: "Notes",
      sourceKinds: ["live-caption"],
      start: async (request) => {
        source = request;
        return { ok: true, session: request.session };
      },
      stop,
    },
  });
  await withPluginRuntimeRegistryScope(registry, () =>
    startTranscripts({ ctx, store, rawParams: { providerId: "notes", sessionId: "meeting" } }),
  );
  return { ctx, store, source, registry, stop, stopStarted: stopStarted.promise, updates };
}

async function saved(fixture: Awaited<ReturnType<typeof capture>>) {
  return (await fixture.store.readSummary(fixture.source.session)).summary;
}

describe("live meeting summaries", () => {
  it("does not regenerate final notes when a stale local owner observes a durable stop", async () => {
    const fixture = await capture();
    await fixture.source.onUtterance({ text: "Saved speech" });
    const stopped = { ...fixture.source.session, stoppedAt: new Date().toISOString() };
    await fixture.store.writeSession(stopped);
    const final = {
      ...summarizeTranscripts({ session: stopped, utterances: [{ text: "Saved speech" }] }),
      overview: "Final notes from the durable owner",
    };
    await fixture.store.writeSummary(final, stopped);
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await settleSummaryUpdates(fixture.updates);
    const tool = createTranscriptsTool(fixture.ctx);
    await withPluginRuntimeRegistryScope(fixture.registry, () =>
      tool.execute("manual", { action: "summarize", sessionId: "meeting" }),
    );
    expect(complete).not.toHaveBeenCalled();
    expect(await saved(fixture)).toEqual(final);
  });
  it("retires failed snapshot initialization and permits capture retry", async () => {
    const stateDir = tempDirs.make("transcript-summary-start-retry-");
    const read = vi
      .spyOn(TranscriptsStore.prototype, "readSummarySnapshot")
      .mockRejectedValueOnce(new Error("Snapshot unavailable"));
    await expect(capture(stateDir)).rejects.toThrow("Snapshot unavailable");
    read.mockRestore();
    const store = createTranscriptsStore({ stateDir, logger: console });
    expect((await store.readSession("meeting"))?.stoppedAt).toBeTruthy();
    const fixture = await capture(stateDir);
    await fixture.source.onUtterance({ text: "Recovered capture" });
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await settleSummaryUpdates(fixture.updates);
    expect(await saved(fixture)).toMatchObject({ source: "model", utteranceCount: 1 });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("stops input while a periodic snapshot is pending and admits only final inference", async () => {
    const fixture = await capture();
    await fixture.source.onUtterance({ text: "Saved speech" });
    const snapshot = await fixture.store.readSummarySnapshot(fixture.source.session, 2_000);
    const read = createDeferred<typeof snapshot>();
    pendingCompletions.add(() => read.resolve(snapshot));
    const pendingRead = vi
      .spyOn(fixture.store, "readSummarySnapshot")
      .mockReturnValueOnce(read.promise);
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await vi.waitFor(() => expect(pendingRead).toHaveBeenCalledOnce());
    const tool = createTranscriptsTool(fixture.ctx);
    const stopped = withPluginRuntimeRegistryScope(fixture.registry, () =>
      tool.execute("stop", { action: "stop", sessionId: "meeting" }),
    );
    await fixture.stopStarted;
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
    read.resolve(snapshot);
    await stopped;
    expect(complete).toHaveBeenCalledOnce();
    expect(await saved(fixture)).toMatchObject({ source: "model", transcript: ["Saved speech"] });
  });

  it("continues under a new work owner after the starting caller closes", async () => {
    const caller = new AsyncWorkScope();
    const fixture = await caller.track(() => capture());
    await caller.drain();
    await fixture.source.onUtterance({ text: "Speech after the start request finished" });
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await settleSummaryUpdates(fixture.updates);
    expect(await saved(fixture)).toMatchObject({ source: "model", utteranceCount: 1 });
    expect(fixture.ctx.logger.warn).not.toHaveBeenCalled();
  });
  it("publishes a captured speech prefix during continued speech and skips unchanged intervals", async () => {
    const fixture = await capture();
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await settleSummaryUpdates(fixture.updates);
    expect(complete).not.toHaveBeenCalled();
    await fixture.source.onUtterance({ text: "First decision" });
    await vi.advanceTimersByTimeAsync(fiveMinutes - 1);
    expect(complete).not.toHaveBeenCalled();
    const pending = holdCompletion();
    await vi.advanceTimersByTimeAsync(1);
    await pending.entered;
    expect(complete).toHaveBeenCalledOnce();
    await fixture.source.onUtterance({ text: "Later decision" });
    pending.resolve(modelNotes());
    await settleSummaryUpdates(fixture.updates);
    expect(await saved(fixture)).toMatchObject({
      source: "model",
      utteranceCount: 1,
      transcript: ["First decision"],
    });
    expect(complete.mock.calls[0]![0]).toMatchObject({
      provider: "test",
      model: "utility",
      agentId: "main",
    });
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await settleSummaryUpdates(fixture.updates);
    expect(await saved(fixture)).toMatchObject({
      utteranceCount: 2,
      transcript: ["First decision", "Later decision"],
    });
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await settleSummaryUpdates(fixture.updates);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("settles cancelled interim inference before finalizing all speech on provider stop", async () => {
    const fixture = await capture();
    await fixture.source.onUtterance({ text: "Before summary" });
    const pending = holdCompletion();
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await pending.entered;
    expect(complete).toHaveBeenCalledOnce();
    await fixture.source.onUtterance({ text: "Final speech" });
    const tool = createTranscriptsTool(fixture.ctx);
    const aborted = new Promise<void>((resolve) => {
      complete.mock.calls[0]![0].abortSignal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
    const stopped = withPluginRuntimeRegistryScope(fixture.registry, () =>
      tool.execute("stop", { action: "stop", sessionId: "meeting" }),
    );
    await aborted;
    expect(complete.mock.calls[0]![0].abortSignal.aborted).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(await saved(fixture)).toBeUndefined();
    pending.resolve(modelNotes());
    await stopped;
    expect(complete).toHaveBeenCalledTimes(2);
    expect(await saved(fixture)).toMatchObject({ transcript: ["Before summary", "Final speech"] });
    expect(activeSessions.size).toBe(0);
    await vi.advanceTimersByTimeAsync(fiveMinutes * 2);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("retains an accepted append failure while terminal summary shutdown is pending", async () => {
    const fixture = await capture();
    await fixture.source.onUtterance({ text: "Saved speech" });
    const pending = holdCompletion();
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await pending.entered;
    const appendEntered = createDeferred();
    const releaseAppend = createDeferred();
    const appendFailure = new Error("Accepted speech could not be saved");
    vi.spyOn(fixture.store, "appendUtteranceForSession").mockImplementationOnce(async () => {
      appendEntered.resolve();
      await releaseAppend.promise;
      throw appendFailure;
    });
    const accepted = Promise.resolve(fixture.source.onUtterance({ text: "Rejected speech" }));
    const acceptedOutcome = accepted.then(
      () => undefined,
      (error: unknown) => error,
    );
    await appendEntered.promise;
    let terminalSettled = false;
    const terminalOutcome = Promise.resolve(fixture.source.onStatus?.({ active: false })).then(
      () => {
        terminalSettled = true;
        return undefined;
      },
      (error: unknown) => {
        terminalSettled = true;
        return error;
      },
    );
    try {
      expect(complete.mock.calls[0]![0].abortSignal.aborted).toBe(true);
      releaseAppend.resolve();
      expect(await acceptedOutcome).toBe(appendFailure);
      expect(terminalSettled).toBe(false);
    } finally {
      releaseAppend.resolve();
      pending.resolve(modelNotes());
      await Promise.all([acceptedOutcome, terminalOutcome]);
    }
    expect(await terminalOutcome).toBe(appendFailure);
    expect((await fixture.store.readSession("meeting"))?.stoppedAt).toBeUndefined();
    expect(await saved(fixture)).toBeUndefined();
    const tool = createTranscriptsTool(fixture.ctx);
    await withPluginRuntimeRegistryScope(fixture.registry, () =>
      tool.execute("retry-stop", { action: "stop", sessionId: "meeting" }),
    );
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(await saved(fixture)).toMatchObject({ transcript: ["Saved speech"] });
    expect(activeSessions.size).toBe(0);
  });

  it("serializes manual summaries with periodic inference and preserves a newer external write", async () => {
    const fixture = await capture();
    await fixture.source.onUtterance({ text: "Opening speech" });
    const pending = holdCompletion();
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await pending.entered;
    expect(complete).toHaveBeenCalledOnce();
    const external = {
      ...summarizeTranscripts({
        session: fixture.source.session,
        utterances: [{ text: "Opening speech" }],
      }),
      overview: "Operator-edited notes",
    };
    await fixture.store.writeSummary(external, fixture.source.session);
    pending.resolve(modelNotes());
    await settleSummaryUpdates(fixture.updates);
    expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(0);
    expect((await saved(fixture))?.overview).toBe("Operator-edited notes");
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await settleSummaryUpdates(fixture.updates);
    expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(0);
    expect(complete).toHaveBeenCalledOnce();
    expect((await saved(fixture))?.overview).toBe("Operator-edited notes");

    const next = holdCompletion();
    await fixture.source.onUtterance({ text: "New speech" });
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await next.entered;
    expect(complete).toHaveBeenCalledTimes(2);
    const tool = createTranscriptsTool(fixture.ctx);
    const manual = withPluginRuntimeRegistryScope(fixture.registry, () =>
      tool.execute("manual", { action: "summarize", sessionId: "meeting" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toHaveBeenCalledTimes(2);
    await fixture.source.onUtterance({ text: "Speech while the manual summary is queued" });
    next.resolve(modelNotes());
    await manual;
    expect(complete).toHaveBeenCalledTimes(3);
    expect(await saved(fixture)).toMatchObject({ utteranceCount: 3 });
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await settleSummaryUpdates(fixture.updates);
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("keeps prior notes without warning when session metadata changes during inference", async () => {
    const fixture = await capture();
    const utterance = { text: "Speech before the title changed" };
    await fixture.source.onUtterance(utterance);
    const previous = {
      ...summarizeTranscripts({ session: fixture.source.session, utterances: [utterance] }),
      overview: "Retained earlier notes",
    };
    await fixture.store.writeSummary(previous, fixture.source.session);
    const pending = holdCompletion();
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await pending.entered;
    try {
      await fixture.store.writeSession({
        ...fixture.source.session,
        title: "Title changed while inference was pending",
      });
    } finally {
      pending.resolve(modelNotes());
      await settleSummaryUpdates(fixture.updates);
    }
    expect(await saved(fixture)).toEqual(previous);
    expect(fixture.ctx.logger.warn).not.toHaveBeenCalled();
  });

  it("uses total speech sequence after the bounded summary window is full", async () => {
    const fixture = await capture();
    for (let index = 0; index < 2_001; index++) {
      await fixture.source.onUtterance({ text: `Speech ${index}` });
    }
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await settleSummaryUpdates(fixture.updates);
    expect((await saved(fixture))?.utteranceCount).toBe(2_000);
    await fixture.source.onUtterance({ text: "Newest speech" });
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await settleSummaryUpdates(fixture.updates);
    expect(complete).toHaveBeenCalledTimes(2);
    expect((await saved(fixture))?.transcript.at(-1)).toBe("Newest speech");
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await settleSummaryUpdates(fixture.updates);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "shares utility summaries and finalization with browser meeting capture (restored: %s)",
    async (restored) => {
      const updates = trackSummaryUpdates();
      const stateDir = tempDirs.make("browser-live-notes-");
      const store = createTranscriptsStore({ stateDir, logger: console });
      const session: MeetingSessionRecord<"chrome", "agent"> = {
        id: "browser-meeting",
        url: "https://meeting.example/room",
        transport: "chrome",
        mode: "agent",
        agentId: "research",
        state: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        participantIdentity: "Synthetic guest",
        realtime: { enabled: true, toolPolicy: "safe-read-only" },
        notes: [],
      };
      if (restored) {
        const previous = {
          sessionId: session.id,
          startedAt: session.createdAt,
          source: { providerId: "meeting", kind: "live-caption" as const },
        };
        const opening = { text: "Earlier speech already summarized" };
        await store.writeSession(previous);
        await store.appendUtteranceForSession(previous, opening);
        await store.writeSummary(
          summarizeTranscripts({ session: previous, utterances: [opening] }),
          previous,
        );
        await store.appendUtteranceForSession(previous, {
          text: "Speech saved after the previous summary",
        });
      }
      const bridge = createMeetingDurableTranscriptBridge({
        logger: { warn: vi.fn() },
        options: { providerId: "meeting", providerName: "Meeting", stateDir, openclawConfig: cfg },
      });
      await bridge.start(session, async () => {});
      try {
        const descriptor = (await store.listSessionEntries())[0]!;
        expect(
          (await getTranscriptLibrary(store, { selector: descriptor.selector })).session,
        ).toMatchObject({ active: true, activeSubscription: true, hasSummary: restored });
        expect((await listTranscriptLibrary(store, {})).sessions[0]).toMatchObject({
          active: true,
          hasSummary: restored,
        });
        if (!restored) {
          await bridge.ingest(session, [
            { at: new Date().toISOString(), speaker: "Ada", text: "We agreed to simplify setup." },
          ]);
        }
        await vi.advanceTimersByTimeAsync(fiveMinutes);
        await settleSummaryUpdates(updates);
        expect(complete).toHaveBeenCalledOnce();
        expect(complete.mock.calls[0]![0]).toMatchObject({ model: "utility", agentId: "research" });
        expect((await store.readSummary(descriptor.session)).summary?.source).toBe("model");
        if (restored) {
          expect((await store.readSummary(descriptor.session)).summary?.transcript).toEqual([
            "Earlier speech already summarized",
            "Speech saved after the previous summary",
          ]);
        }
        expect(
          (await getTranscriptLibrary(store, { selector: descriptor.selector })).session,
        ).toMatchObject({ active: true, hasSummary: true });
        expect((await listTranscriptLibrary(store, {})).sessions[0]).toMatchObject({
          active: true,
          hasSummary: true,
        });
        await bridge.stop(session, async () => {});
        expect(complete).toHaveBeenCalledTimes(2);
        expect((await store.readSession(session.id))?.stoppedAt).toBeTruthy();
        expect(
          (await getTranscriptLibrary(store, { selector: descriptor.selector })).session,
        ).toMatchObject({ active: false, activeSubscription: false });
        expect((await listTranscriptLibrary(store, {})).sessions[0]).toMatchObject({
          active: false,
        });
      } finally {
        await bridge.stop(session, async () => {});
      }
    },
  );
});
