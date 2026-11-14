import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "../agents/isolated-completion.js";
import "../agents/utility-completion.js";
import type { MeetingSessionRecord } from "../meeting-bot/session-types.js";
import { createMeetingDurableTranscriptBridge } from "../meeting-bot/transcripts-bridge.runtime.js";
import * as gatewayWorkAdmission from "../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createTranscriptsStore } from "./capture-operations.js";
import { activeSessions, prepareTranscriptCaptureDisable } from "./capture-startup.js";
import { getTranscriptLibrary, listTranscriptLibrary } from "./library.js";
import type { TranscriptStartRequest } from "./provider-types.js";
import { useTranscriptStatusFixture } from "./status.producer.test-harness.js";
import { TranscriptsStore } from "./store.js";
import { summarizeTranscripts, type TranscriptsSummary } from "./summary.js";

const { complete, select, loadRuntime } = vi.hoisted(() => ({
  complete: vi.fn(),
  select: vi.fn(),
  loadRuntime: vi.fn(),
}));
vi.mock("./summary-model.runtime.js", async (importOriginal) => {
  loadRuntime();
  return {
    ...(await importOriginal<typeof import("./summary-model.runtime.js")>()),
    runIsolatedCompletion: complete,
    runUtilityCompletion: complete,
    resolveSimpleCompletionSelectionForAgent: select,
  };
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const makeCapture = useTranscriptStatusFixture();
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
  return { entered: entered.promise, resolve: () => pending.resolve(modelNotes()) };
}
async function pendingInterval() {
  const pending = holdCompletion();
  await vi.advanceTimersByTimeAsync(fiveMinutes);
  await pending.entered;
  return pending;
}
const inference = (index = 0) => complete.mock.calls[index]![0];
const expectCalls = (count: number) => expect(complete).toHaveBeenCalledTimes(count);
function trackSummaryUpdates() {
  return vi.spyOn(gatewayWorkAdmission, "runWithGatewayDetachedWorkAdmission");
}
async function settleSummaryUpdates(updates: ReturnType<typeof trackSummaryUpdates>) {
  await Promise.all(updates.mock.results.map(({ value }) => value));
  // The capture owner rearms its timer in the continuation after detached work settles.
  await vi.advanceTimersByTimeAsync(0);
}
async function advanceSummaryInterval(updates: ReturnType<typeof trackSummaryUpdates>) {
  await vi.advanceTimersByTimeAsync(fiveMinutes);
  await settleSummaryUpdates(updates);
}
const cfg = { agents: { defaults: { utilityModel: "test/utility", model: "test/primary" } } };
const modelNotes = () => ({
  text: JSON.stringify({ overview: "Notes", decisions: [], actionItems: [], risks: [] }),
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
async function capture(initialText?: string) {
  const { ctx, store, provider, start, tool } = makeCapture(cfg);
  provider.sourceKinds = ["live-caption"];
  const updates = trackSummaryUpdates();
  let source!: TranscriptStartRequest;
  const stopStarted = createDeferred();
  const stop = vi.fn<NonNullable<typeof provider.stop>>(async ({ sessionId }) => {
    stopStarted.resolve();
    return { ok: true, sessionId };
  });
  provider.start = async (request) => {
    source = request;
    return { ok: true, session: request.session };
  };
  provider.stop = stop;
  await start({ providerId: provider.id, sessionId: "meeting" });
  const speak = (text: string) => source.onUtterance({ text });
  const saved = async () => (await store.readSummary(source.session)).summary;
  if (initialText) {
    await speak(initialText);
  }
  return {
    ctx,
    store,
    source,
    stop,
    stopStarted: stopStarted.promise,
    speak,
    saved,
    async expectSummary(expected: Partial<TranscriptsSummary>, calls?: number) {
      expect(await saved()).toMatchObject(expected);
      if (calls !== undefined) {
        expectCalls(calls);
      }
    },
    session: () => store.readSession("meeting"),
    advance: () => advanceSummaryInterval(updates),
    settle: () => settleSummaryUpdates(updates),
    execute(id: string, action: "stop" | "summarize") {
      vi.stubEnv("OPENCLAW_STATE_DIR", ctx.stateDir);
      return tool.execute(id, { action, sessionId: "meeting" });
    },
  };
}

async function expectLibraryState(
  store: TranscriptsStore,
  selector: string,
  active: boolean,
  hasSummary?: boolean,
) {
  const expected = { active, ...(hasSummary === undefined ? {} : { hasSummary }) };
  expect((await getTranscriptLibrary(store, { selector })).session).toMatchObject({
    ...expected,
    activeSubscription: active,
  });
  expect((await listTranscriptLibrary(store, {})).sessions[0]).toMatchObject(expected);
}

describe("live meeting summaries", () => {
  // Inner cleanup releases held inference before the shared capture fixture retires it.
  afterEach(() => {
    for (const settle of pendingCompletions) {
      settle();
    }
    pendingCompletions.clear();
  });
  it.each(["restart-drain", "capture-policy"] as const)(
    "persists final speech without loading inference after %s closes admission",
    async (reason) => {
      const fixture = await capture("Accepted speech before shutdown");
      const runtimeLoadsBeforeShutdown = loadRuntime.mock.calls.length;
      const policy =
        reason === "capture-policy"
          ? prepareTranscriptCaptureDisable(fixture.ctx.stateDir)
          : undefined;
      if (reason !== "capture-policy") {
        gatewayWorkAdmission.markGatewayRestartDraining();
      }
      try {
        if (policy) {
          await policy.drain();
        } else {
          await fixture.execute("shutdown", "stop");
        }
        expect(loadRuntime).toHaveBeenCalledTimes(runtimeLoadsBeforeShutdown);
        expectCalls(0);
        expect(fixture.stop).toHaveBeenCalledOnce();
        await fixture.expectSummary({
          source: "heuristic",
          transcript: ["Accepted speech before shutdown"],
        });
        expect((await fixture.session())?.stoppedAt).toBeTruthy();
        expect(activeSessions.size).toBe(0);
      } finally {
        policy?.resume();
        gatewayWorkAdmission.resetGatewayWorkAdmission();
      }
    },
  );

  it("does not regenerate final notes after a durable stop", async () => {
    const fixture = await capture("Saved speech");
    const stopped = { ...fixture.source.session, stoppedAt: new Date().toISOString() };
    await fixture.store.writeSession(stopped);
    const final = {
      ...summarizeTranscripts({ session: stopped, utterances: [{ text: "Saved speech" }] }),
      overview: "Final notes from the durable owner",
    };
    await fixture.store.writeSummary(final, stopped);
    await fixture.advance();
    await fixture.execute("manual", "summarize");
    expectCalls(0);
    expect(await fixture.saved()).toEqual(final);
  });

  it("stops pending snapshot input before final inference", async () => {
    const fixture = await capture("Saved speech");
    const snapshot = await fixture.store.readSummarySnapshot(fixture.source.session, 2_000);
    const read = createDeferred<typeof snapshot>();
    pendingCompletions.add(() => read.resolve(snapshot));
    const pendingRead = vi
      .spyOn(fixture.store, "readSummarySnapshot")
      .mockReturnValueOnce(read.promise);
    await vi.advanceTimersByTimeAsync(fiveMinutes);
    await vi.waitFor(() => expect(pendingRead).toHaveBeenCalledOnce());
    const stopped = fixture.execute("stop", "stop");
    await fixture.stopStarted;
    expect(fixture.stop).toHaveBeenCalledOnce();
    expectCalls(0);
    read.resolve(snapshot);
    await stopped;
    await fixture.expectSummary({ source: "model", transcript: ["Saved speech"] }, 1);
  });

  it("outlives its caller and skips unchanged intervals", async () => {
    const snapshots = vi.spyOn(TranscriptsStore.prototype, "readSummarySnapshot");
    const caller = new AsyncWorkScope();
    const fixture = await caller.track(() => capture());
    expect(snapshots).not.toHaveBeenCalled();
    await caller.drain();
    await fixture.advance();
    expect(snapshots).toHaveBeenCalledOnce();
    expectCalls(0);
    await fixture.speak("First decision");
    await vi.advanceTimersByTimeAsync(fiveMinutes - 1);
    expectCalls(0);
    const pending = holdCompletion();
    await vi.advanceTimersByTimeAsync(1);
    await pending.entered;
    expectCalls(1);
    await fixture.speak("Later decision");
    pending.resolve();
    await fixture.settle();
    await fixture.expectSummary({
      source: "model",
      utteranceCount: 1,
      transcript: ["First decision"],
    });
    expect(fixture.ctx.logger.warn).not.toHaveBeenCalled();
    expect(inference()).toMatchObject({
      provider: "test",
      model: "utility",
      agentId: "main",
    });
    await fixture.advance();
    await fixture.expectSummary({
      utteranceCount: 2,
      transcript: ["First decision", "Later decision"],
    });
    await fixture.advance();
    expectCalls(2);
  });

  it("recovers on the next interval after a failed snapshot", async () => {
    const fixture = await capture("Saved speech");
    vi.spyOn(fixture.store, "readSummarySnapshot").mockRejectedValueOnce(
      new Error("Snapshot unavailable"),
    );
    await expect(fixture.advance()).rejects.toThrow("Snapshot unavailable");
    await vi.advanceTimersByTimeAsync(0);
    expectCalls(0);
    expect(fixture.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Snapshot unavailable"),
    );
    // The fixture must not rejoin the already-observed rejected interval.
    vi.mocked(gatewayWorkAdmission.runWithGatewayDetachedWorkAdmission).mockClear();
    await fixture.advance();
    await fixture.expectSummary({ source: "model", transcript: ["Saved speech"] }, 1);
  });

  it("settles cancelled interim inference before finalizing provider stop", async () => {
    const fixture = await capture("Before summary");
    const pending = await pendingInterval();
    expectCalls(1);
    await fixture.speak("Final speech");
    const aborted = new Promise<void>((resolve) => {
      inference().abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    const stopped = fixture.execute("stop", "stop");
    await aborted;
    expect(inference().abortSignal.aborted).toBe(true);
    expectCalls(1);
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(await fixture.saved()).toBeUndefined();
    pending.resolve();
    await stopped;
    await fixture.expectSummary({ transcript: ["Before summary", "Final speech"] }, 2);
    expect(activeSessions.size).toBe(0);
    await vi.advanceTimersByTimeAsync(fiveMinutes * 2);
    expectCalls(2);
  });

  it("retains accepted append failures during terminal shutdown", async () => {
    const fixture = await capture("Saved speech");
    const pending = await pendingInterval();
    const appendEntered = createDeferred();
    const releaseAppend = createDeferred();
    const appendFailure = new Error("Accepted speech could not be saved");
    vi.spyOn(fixture.store, "appendUtteranceForSession").mockImplementationOnce(async () => {
      appendEntered.resolve();
      await releaseAppend.promise;
      throw appendFailure;
    });
    const acceptedOutcome = Promise.resolve(fixture.speak("Rejected speech")).then(
      () => undefined,
      (error: unknown) => error,
    );
    await appendEntered.promise;
    const terminalSettled = vi.fn();
    const terminalOutcome = Promise.resolve(fixture.source.onStatus?.({ active: false })).then(
      terminalSettled,
      (error: unknown) => {
        terminalSettled();
        return error;
      },
    );
    try {
      expect(inference().abortSignal.aborted).toBe(true);
      releaseAppend.resolve();
      expect(await acceptedOutcome).toBe(appendFailure);
      expect(terminalSettled).not.toHaveBeenCalled();
    } finally {
      releaseAppend.resolve();
      pending.resolve();
      await Promise.all([acceptedOutcome, terminalOutcome]);
    }
    expect(await terminalOutcome).toBe(appendFailure);
    expect((await fixture.session())?.stoppedAt).toBeUndefined();
    expect(await fixture.saved()).toBeUndefined();
    await fixture.execute("retry-stop", "stop");
    expect(fixture.stop).not.toHaveBeenCalled();
    await fixture.expectSummary({ transcript: ["Saved speech"] });
    expect(activeSessions.size).toBe(0);
  });

  it.each(["summary", "session"] as const)(
    "keeps newer %s writes and serializes manual and periodic summaries",
    async (changed) => {
      const fixture = await capture("Opening speech");
      const utterance = { text: "Opening speech" };
      const external = {
        ...summarizeTranscripts({ session: fixture.source.session, utterances: [utterance] }),
        overview: "Operator-edited notes",
      };
      if (changed === "session") {
        await fixture.store.writeSummary(external, fixture.source.session);
      }
      const pending = await pendingInterval();
      expectCalls(1);
      try {
        if (changed === "summary") {
          await fixture.store.writeSummary(external, fixture.source.session);
        } else {
          await fixture.store.writeSession({
            ...fixture.source.session,
            title: "Title changed while inference was pending",
          });
        }
      } finally {
        pending.resolve();
        await fixture.settle();
      }
      expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(0);
      expect(await fixture.saved()).toEqual(external);
      expect(fixture.ctx.logger.warn).not.toHaveBeenCalled();
      await fixture.advance();
      expect(gatewayWorkAdmission.getActiveGatewayRootWorkCount()).toBe(0);
      expectCalls(1);
      expect((await fixture.saved())?.overview).toBe("Operator-edited notes");

      await fixture.speak("New speech");
      const next = await pendingInterval();
      expectCalls(2);
      const manual = fixture.execute("manual", "summarize");
      await vi.advanceTimersByTimeAsync(0);
      expectCalls(2);
      await fixture.speak("Speech while the manual summary is queued");
      next.resolve();
      await manual;
      await fixture.expectSummary({ utteranceCount: 3 }, 3);
      await fixture.advance();
      expectCalls(3);
    },
  );

  it("uses total speech sequence after the bounded summary window is full", async () => {
    const fixture = await capture();
    for (let index = 0; index < 2_001; index++) {
      await fixture.speak(`Speech ${index}`);
    }
    await fixture.advance();
    expect((await fixture.saved())?.utteranceCount).toBe(2_000);
    await fixture.speak("Newest speech");
    await fixture.advance();
    expectCalls(2);
    expect((await fixture.saved())?.transcript.at(-1)).toBe("Newest speech");
    await fixture.advance();
    expectCalls(2);
  });

  it("refreshes restored browser notes and finalizes the same summary lane", async () => {
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
    const bridge = createMeetingDurableTranscriptBridge({
      logger: { warn: vi.fn() },
      options: { providerId: "meeting", providerName: "Meeting", stateDir, openclawConfig: cfg },
    });
    await bridge.start(session, async () => {});
    try {
      const descriptor = (await store.listSessionEntries())[0]!;
      await expectLibraryState(store, descriptor.selector, true, true);
      await advanceSummaryInterval(updates);
      expectCalls(1);
      expect(inference()).toMatchObject({ model: "utility", agentId: "research" });
      expect((await store.readSummary(descriptor.session)).summary?.source).toBe("model");
      expect((await store.readSummary(descriptor.session)).summary?.transcript).toEqual([
        "Earlier speech already summarized",
        "Speech saved after the previous summary",
      ]);
      await expectLibraryState(store, descriptor.selector, true, true);
      await bridge.stop(session, async () => {});
      expectCalls(2);
      expect((await store.readSession(session.id))?.stoppedAt).toBeTruthy();
      await expectLibraryState(store, descriptor.selector, false);
    } finally {
      await bridge.stop(session, async () => {});
    }
  });
});
