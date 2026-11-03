import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createMeetingNodeBrowserFixture } from "../plugin-sdk/test-helpers/meeting-browser.js";
import { defineMeetingChromeCleanupTests } from "../plugin-sdk/test-helpers/meeting-chrome-contract.js";
import { useMeetingTestState } from "../plugin-sdk/test-helpers/meeting-state.js";
import { createOpenClawTestState } from "../plugin-sdk/test-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { TranscriptsStore } from "../transcripts/store.js";
import { loadBrowserMeetingPlugins } from "./browser-plugin.test-support.js";
import { TEST_MEETING_PLATFORM_METADATA } from "./observation-provenance.test-support.js";
import { createMeetingSession } from "./session-factory.js";
import {
  createTestRuntime,
  captionSnapshot,
  releaseTab,
  testBrowser,
  type TestSession,
  type TestJoinContext,
} from "./session-runtime.test-support.js";

const engineMocks = vi.hoisted(() => ({
  localDispose: vi.fn(async () => {}),
  nodeDispose: vi.fn(async () => {}),
  speak: vi.fn(),
  startAgent: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/meeting-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/meeting-runtime")>();
  const adapter = original.MeetingPlatformAdapter;
  const transport = (dispose: () => Promise<void>) => ({
    clearOutput: vi.fn(async () => {}),
    dispose,
    onFatal: vi.fn(),
    startInput: vi.fn(),
    stop: dispose,
    writeOutput: vi.fn(async () => {}),
  });
  const defineBrowserMeetingPlugin: typeof adapter.defineBrowserMeetingPlugin = (spec) =>
    adapter.defineBrowserMeetingPlugin({
      ...spec,
      chromeRuntime: {
        ...adapter.createChromeRuntimeBindings(),
        createLocalAudioTransport: () => transport(engineMocks.localDispose),
        createNodeAudioTransport: () => transport(engineMocks.nodeDispose),
        startAgentRealtimeEngine: engineMocks.startAgent,
      },
    });
  return { ...original, MeetingPlatformAdapter: { ...adapter, defineBrowserMeetingPlugin } };
});

const { zoomMeetingsPlugin, teamsMeetingsPlugin } = await loadBrowserMeetingPlugins();

const room = { url: "https://meeting.example/room", agentId: "main" };
const notes = { url: "https://meeting.example/notes", agentId: "notes-agent" };

function createNotesRuntime(overrides: Partial<Parameters<typeof createTestRuntime>[0]>) {
  return createTestRuntime({
    joinTransport: joinBrowser("notes-tab"),
    releaseBrowserTab: async () => true,
    ...overrides,
  });
}

function joinBrowser(
  target: string | ((session: TestSession) => string),
  stop?: () => Promise<void>,
  failure?: Error,
) {
  return vi.fn(async ({ session, context }: { session: TestSession; context: TestJoinContext }) => {
    session.browser = testBrowser(typeof target === "string" ? target : target(session));
    if (stop) {
      context.attachRuntimeHandles(session, { stop });
    }
    if (failure) {
      throw failure;
    }
    return {};
  });
}

function transcriptSource(
  session: TestSession,
  sessionId: string,
  source: { agentId?: string; channelId?: string } = {},
) {
  return {
    sessionId,
    source: {
      providerId: "test-meeting",
      agentId: session.agentId,
      meetingUrl: session.url,
      ...source,
    },
    startedAt: session.createdAt,
  };
}

const transcriptStore = (stateDir: string) =>
  new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });

describe("createMeetingSession", () => {
  it("preserves bidi realtime session fields", () => {
    const session = createMeetingSession({
      platform: {
        ...TEST_MEETING_PLATFORM_METADATA,
        session: {
          idPrefix: "test_meeting",
          participantIdentity: (transport) => `Test participant via ${transport}`,
        },
      },
      config: {
        realtime: {
          provider: "deepgram",
          voiceProvider: "openai-realtime",
          transcriptionProvider: "deepgram",
          model: "realtime-model",
          toolPolicy: "safe-read-only",
        },
      },
      resolved: {
        url: "https://meeting.example/room",
        transport: "chrome",
        mode: "bidi",
        agentId: "operator",
      },
      createdAt: "2026-07-22T00:00:00.000Z",
    });

    expect(session).toMatchObject({
      id: expect.stringMatching(/^test_meeting_/),
      state: "active",
      participantIdentity: "Test participant via chrome",
      realtime: {
        enabled: true,
        strategy: "bidi",
        provider: "openai-realtime",
        model: "realtime-model",
        transcriptionProvider: undefined,
        toolPolicy: "safe-read-only",
      },
      notes: [],
    });
  });
});

const tempDirs = createTempDirTracker();

afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("MeetingSessionRuntime durable transcripts", () => {
  it.each([false, true])(
    "suspends durable notes without leaving and resumes past disabled captions (failed finalization: %s)",
    async (failFinalization) => {
      const stateDir = tempDirs.make("openclaw-meeting-policy-");
      const lines = [{ text: "before suspension" }];
      const releaseBrowserTab = vi.fn(async () => true);
      const captureTranscript = vi.fn(async () => ({
        droppedLines: 0,
        epoch: "same-live-page",
        lines: [...lines],
      }));
      const { runtime } = createNotesRuntime({
        captureTranscript,
        durableTranscripts: { stateDir },
        releaseBrowserTab,
      });
      const { session } = await runtime.join({
        url: "https://meeting.example/policy",
        agentId: "notes-agent",
      });
      const store = transcriptStore(stateDir);
      const writeSession = store.writeSession.bind(store);
      const fault = vi
        .spyOn(TranscriptsStore.prototype, "writeSession")
        .mockImplementation(async (descriptor) => {
          if (failFinalization && descriptor.stoppedAt) {
            throw new Error("metadata unavailable");
          }
          return writeSession(descriptor);
        });
      lines.push({ text: "accepted final caption" });
      const disabling = runtime.reconcileTranscriptPolicy(false);
      await expect(
        runtime.startTranscriptSource({
          session: transcriptSource(session, "late-subscriber"),
          onUtterance: vi.fn(),
        }),
      ).resolves.toMatchObject({ ok: false });
      if (failFinalization) {
        await expect(disabling).rejects.toThrow("metadata unavailable");
      } else {
        await disabling;
      }
      fault.mockRestore();
      expect(session.state).toBe("active");
      expect(releaseBrowserTab).not.toHaveBeenCalled();
      expect(captureTranscript).not.toHaveBeenCalledWith({ finalize: true });

      lines.push({ text: "while disabled" });
      await runtime.reconcileTranscriptPolicy(true);
      lines.push({ text: "after resuming" });
      await runtime.leave(session.id);

      const saved = await store.readSession(session.id);
      expect(saved?.stoppedAt).toEqual(expect.any(String));
      expect((await store.readUtterancesForSession(saved!)).map((line) => line.text)).toEqual([
        "before suspension",
        "accepted final caption",
        "after resuming",
      ]);
      expect(await store.readSummary(saved!)).toMatchObject({ summary: { utteranceCount: 3 } });
      expect(releaseBrowserTab).toHaveBeenCalledOnce();
    },
  );

  it("persists joined agent-mode captions and writes summary rows on leave", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-notes-");
    const first = {
      at: "2026-07-23T12:00:00.000Z",
      speaker: "Avery",
      text: "We decided to ship the durable notes bridge.",
    };
    const second = {
      at: "2026-07-23T12:00:05.000Z",
      speaker: "Blake",
      text: "Action: follow up with the docs.",
    };
    const snapshots = [captionSnapshot([first]), captionSnapshot([first, second])];
    const { runtime } = createNotesRuntime({
      captureTranscript: async () => snapshots.shift(),
      durableTranscripts: { stateDir },
    });

    const { session } = await runtime.join({
      ...notes,
      url: `${notes.url}?context=opaque-value`,
    });
    await expect(
      runtime.startTranscriptSource({
        session: transcriptSource(session, "external-mismatch", { channelId: "another-session" }),
        onUtterance: vi.fn(),
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      runtime.startTranscriptSource({
        session: transcriptSource(session, "external-agent-mismatch", { agentId: "another-agent" }),
        onUtterance: vi.fn(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "No active meeting session matches the transcript source.",
    });
    await runtime.leave(session.id);

    const store = transcriptStore(stateDir);
    const storedSession = await store.readSession(session.id);
    expect(storedSession).toMatchObject({
      sessionId: session.id,
      source: { providerId: "test-meeting", meetingUrl: "https://meeting.example/notes" },
      metadata: { agentId: "notes-agent", meetingSessionId: session.id, mode: "agent" },
      stoppedAt: expect.any(String),
    });
    expect(await store.readUtterancesForSession(storedSession!)).toMatchObject([
      { speaker: { label: "Avery" }, text: "We decided to ship the durable notes bridge." },
      { speaker: { label: "Blake" }, text: "Action: follow up with the docs." },
    ]);
    expect(await store.readSummary(storedSession!)).toMatchObject({
      summary: {
        actionItems: [
          "Avery: We decided to ship the durable notes bridge.",
          "Blake: Action: follow up with the docs.",
        ],
        decisions: ["Avery: We decided to ship the durable notes bridge."],
        utteranceCount: 2,
      },
    });
  });

  it("keeps transcribe finalization when durable session startup fails", async () => {
    const tempDir = tempDirs.make("openclaw-meeting-notes-");
    const blockedStateDir = path.join(tempDir, "not-a-directory");
    await fs.writeFile(blockedStateDir, "blocked", "utf8");
    const captureTranscript = vi.fn(async () => ({ droppedLines: 0, lines: [] }));
    const { runtime } = createNotesRuntime({
      captureTranscript,
      durableTranscripts: { stateDir: blockedStateDir },
      transcribe: true,
    });

    const { session } = await runtime.join(notes);
    await runtime.leave(session.id);

    expect(captureTranscript).toHaveBeenCalledTimes(2);
    expect(captureTranscript).toHaveBeenCalledWith({ finalize: true });
  });

  it("does not let subscriber delivery failure block meeting leave", async () => {
    const stateDir = tempDirs.make("openclaw-meeting-notes-");
    const snapshots = [
      captionSnapshot([]),
      captionSnapshot([{ speaker: "Avery", text: "Final decision" }]),
    ];
    const releaseBrowserTab = vi.fn(async () => true);
    const { runtime } = createNotesRuntime({
      captureTranscript: async () => snapshots.shift(),
      durableTranscripts: { stateDir },
      transcribe: true,
      releaseBrowserTab,
    });
    const { session } = await runtime.join(notes);
    const onUtterance = vi.fn(async () => {
      throw new Error("subscriber unavailable");
    });
    await runtime.startTranscriptSource({
      session: transcriptSource(session, "external-final"),
      onUtterance,
    });

    await expect(runtime.leave(session.id)).resolves.toMatchObject({ found: true });
    expect(session.state).toBe("ended");
    expect(releaseBrowserTab).toHaveBeenCalledOnce();

    const store = transcriptStore(stateDir);
    const stored = await store.readSession(session.id);
    expect(await store.readUtterancesForSession(stored!)).toHaveLength(1);
    expect(await store.readSummary(stored!)).toMatchObject({ summary: { utteranceCount: 1 } });
    expect(onUtterance).toHaveBeenCalledOnce();
  });
});

describe("MeetingSessionRuntime failed joins", () => {
  it.each([false, true])(
    "permits same-URL retry with retained tab custody (failed join: %s)",
    async (failedJoin) => {
      const launchError = new Error("browser launch failed");
      let launches = 0;
      let releaseAllowed = false;
      const request = { url: "https://meeting.example/retry", agentId: "main" };
      const { runtime } = createTestRuntime({
        releaseBrowserTab: async (session) => {
          if (!session.browser?.tab || !releaseAllowed) {
            return false;
          }
          session.browser.tab = undefined;
          return true;
        },
        joinTransport: async ({ session }) => {
          launches += 1;
          session.browser = testBrowser(`${session.id}-retry-tab`);
          if (failedJoin && launches === 1) {
            throw launchError;
          }
          return {};
        },
      });
      try {
        let pending: TestSession | undefined;
        if (failedJoin) {
          await expect(runtime.join(request)).rejects.toBe(launchError);
          pending = runtime.list()[0];
          expect(runtime.list()).toHaveLength(1);
        } else {
          pending = (await runtime.join(request)).session;
          await expect(runtime.leave(pending.id)).resolves.toMatchObject({ browserLeft: false });
        }
        const retried = await runtime.join(request);
        expect(retried.session.state).toBe("active");
        expect(launches).toBe(2);
        if (pending) {
          expect(retried.session.id).not.toBe(pending.id);
          expect(pending.browser?.tab).toBeDefined();
          releaseAllowed = true;
          await expect(runtime.leave(pending.id)).resolves.toMatchObject({ browserLeft: true });
        }
        if (failedJoin) {
          expect(runtime.list()).toEqual([retried.session]);
        }
      } finally {
        releaseAllowed = true;
        for (const session of runtime.list()) {
          await runtime.leave(session.id);
        }
      }
    },
  );

  it("cleans an externally ended reusable session before replacing it", async () => {
    const stop = vi.fn(async () => {});
    const releaseBrowserTab = vi.fn(async () => true);
    const joinTransport = joinBrowser((session) => session.id, stop);
    const { runtime } = createTestRuntime({
      joinTransport,
      refreshReusableSession: async (session) => {
        session.state = "ended";
      },
      releaseBrowserTab,
    });
    const first = await runtime.join(room);
    const replacement = await runtime.join(room);

    expect(first.session.state).toBe("ended");
    expect(replacement.session.id).not.toBe(first.session.id);
    expect(stop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).not.toHaveBeenCalled();
    expect(joinTransport).toHaveBeenCalledTimes(2);
  });

  it.each(["browser", "transport", "blocked transport"] as const)(
    "retains failed-join %s cleanup for an explicit retry",
    async (failure) => {
      const blocked = failure === "blocked transport";
      const joinError = new Error("transport setup failed");
      const cleanupError = new Error("transport cleanup still pending");
      let releaseStop = !blocked;
      let resourceLive = true;
      const stop = vi.fn(async () => {
        if (!releaseStop) {
          throw cleanupError;
        }
        resourceLive = false;
      });
      if (failure === "transport") {
        stop.mockRejectedValueOnce(new Error("transport stop failed"));
      }
      let releaseAttempts = 0;
      const releaseBrowserTab = vi.fn(async (session: TestSession) => {
        if (
          (blocked && !session.browser?.tab) ||
          (failure === "browser" && releaseAttempts++ === 0)
        ) {
          return false;
        }
        return releaseTab(session);
      });
      const { createdSessions, runtime } = createTestRuntime({
        releaseBrowserTab,
        joinTransport: joinBrowser("partial-tab", stop, joinError),
      });
      try {
        await expect(runtime.join(room)).rejects.toBe(joinError);
        expect(runtime.list()).toEqual(createdSessions);
        expect(createdSessions).toHaveLength(1);
        expect(stop).toHaveBeenCalledOnce();
        expect(releaseBrowserTab).toHaveBeenCalledOnce();
        const original = createdSessions[0]!;
        if (blocked) {
          expect(resourceLive).toBe(true);
          await expect(runtime.status(original.id)).resolves.toMatchObject({ found: true });
          await expect(runtime.join(room)).rejects.toBe(cleanupError);
          expect(createdSessions).toHaveLength(1);
          expect(resourceLive).toBe(true);
          expect(stop).toHaveBeenCalledTimes(2);
          releaseStop = true;
        }
        await runtime.leave(original.id);
        expect(stop).toHaveBeenCalledTimes(blocked ? 3 : failure === "transport" ? 2 : 1);
        if (!blocked) {
          expect(releaseBrowserTab).toHaveBeenCalledTimes(failure === "browser" ? 2 : 1);
        }
        expect(original).toMatchObject({ state: "ended", browser: { tab: undefined } });
        expect(runtime.list()).toEqual([]);
        if (blocked) {
          expect(resourceLive).toBe(false);
          await expect(runtime.status(original.id)).resolves.toMatchObject({ found: false });
        }
      } finally {
        if (blocked && resourceLive) {
          releaseStop = true;
          await stop();
        }
      }
    },
  );

  it.each([false, true])(
    "retries retained settlement after replacement fails (prior stop rejects: %s)",
    async (stopFails) => {
      const stopError = new Error("previous transport stop failed");
      const settlementError = new Error("retained release rejected");
      const oldStop = vi.fn(async () => {
        if (stopFails) {
          throw stopError;
        }
      });
      const replacementStop = vi.fn(async () => {});
      const releaseOrder: string[] = [];
      let oldReleaseAttempts = 0;
      const releaseBrowserTab = vi.fn(async (session: TestSession) => {
        releaseOrder.push(session.id);
        if (session.id === "session-1" && oldReleaseAttempts++ === 0) {
          throw settlementError;
        }
        return releaseTab(session);
      });
      const joinTransport = vi.fn(
        async ({ session, context }: { session: TestSession; context: TestJoinContext }) => {
          const first = session.id === "session-1";
          session.browser = testBrowser(first ? "retained-tab" : "replacement-tab");
          context.attachRuntimeHandles(session, { stop: first ? oldStop : replacementStop });
          return {};
        },
      );
      const { createdSessions, runtime } = createTestRuntime({ releaseBrowserTab, joinTransport });
      await runtime.join({ ...room, agentId: "support" });
      await expect(runtime.join(room)).rejects.toBe(stopFails ? stopError : settlementError);
      expect(oldStop).toHaveBeenCalledOnce();
      expect(joinTransport).toHaveBeenCalledTimes(stopFails ? 1 : 2);
      expect(releaseOrder).toEqual(
        stopFails ? ["session-1", "session-1"] : ["session-1", "session-2", "session-1"],
      );
      expect(releaseBrowserTab).toHaveBeenCalledTimes(stopFails ? 2 : 3);
      expect(createdSessions[0]).toMatchObject({ state: "ended", browser: { tab: undefined } });
      if (!stopFails) {
        expect(replacementStop).toHaveBeenCalledOnce();
        expect(createdSessions[1]).toMatchObject({ state: "ended", browser: { tab: undefined } });
      }
    },
  );
});

describe("MeetingSessionRuntime leave cleanup", () => {
  it("settles concurrent leaves through the meeting queue without repeating cleanup", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const stop = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const releaseBrowserTab = vi.fn(async () => true);
    const { runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: joinBrowser("leave-tab", stop),
    });
    const { session } = await runtime.join(room);
    const first = runtime.leave(session.id);
    await entered.promise;
    const second = runtime.leave(session.id);
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { found: true, session, browserLeft: true },
      { found: true, session, browserLeft: true },
    ]);
    expect(stop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).toHaveBeenCalledOnce();
  });

  it("clears stale in-call health after confirmed browser departure", async () => {
    const { runtime } = createTestRuntime({
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = testBrowser("leave-tab", {
          health: {
            inCall: true,
            micMuted: false,
            manualAction: { reason: "old-action", message: "old action" },
            speechReady: true,
            speechBlockedMessage: "old speech block",
            speechBlockedReason: "old-speech-block",
          },
        });
        return {};
      },
    });
    const { session } = await runtime.join(room);

    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      browserLeft: true,
      session: {
        browser: {
          health: {
            inCall: false,
            manualAction: undefined,
            speechReady: false,
            micMuted: undefined,
            speechBlockedReason: undefined,
            speechBlockedMessage: undefined,
          },
        },
      },
    });
  });

  it.each(["transport", "browser"])(
    "retries failed %s cleanup without repeating settled work",
    async (failure) => {
      const stopError = new Error("transport stop failed");
      const stop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
      if (failure === "transport") {
        stop.mockRejectedValueOnce(stopError);
      }
      const releaseBrowserTab = vi.fn(async (session: TestSession) => {
        if (failure === "transport" && session.browser) {
          session.browser.tab = undefined;
        }
        return true;
      });
      if (failure === "browser") {
        releaseBrowserTab.mockResolvedValueOnce(false);
      }
      const { runtime } = createTestRuntime({
        releaseBrowserTab,
        joinTransport: async ({ session, context }) => {
          session.browser = {
            launched: true,
            tab: { targetId: "leave-tab", openedByPlugin: true },
          };
          context.attachRuntimeHandles(session, { stop });
          return {};
        },
      });
      const { session } = await runtime.join({
        url: "https://meeting.example/room",
        agentId: "main",
      });
      const leaving = runtime.leave(session.id);
      if (failure === "transport") {
        await expect(leaving).rejects.toBe(stopError);
      } else {
        await expect(leaving).resolves.toMatchObject({ found: true, browserLeft: false });
      }
      await expect(runtime.leave(session.id)).resolves.toMatchObject({
        found: true,
        browserLeft: true,
      });
      expect(stop).toHaveBeenCalledTimes(failure === "transport" ? 2 : 1);
      expect(releaseBrowserTab).toHaveBeenCalledTimes(failure === "browser" ? 2 : 1);
    },
  );
});

describe("MeetingSessionRuntime speech readiness", () => {
  it("treats an unknown microphone state as transiently unverified", async () => {
    const { runtime } = createTestRuntime({
      talkBack: true,
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = { launched: true, hasAudioBridge: true, health: { inCall: true } };
        return {};
      },
    });
    const { session } = await runtime.join(room);

    expect(runtime.refreshSpeechReadiness(session)).toEqual({
      ready: false,
      reason: "browser-unverified",
      message: "browser unverified",
    });
    expect(session.browser?.health).toMatchObject({
      speechReady: false,
      speechBlockedReason: "browser-unverified",
    });

    session.browser!.health = { ...session.browser?.health, micMuted: false };
    expect(runtime.refreshSpeechReadiness(session)).toEqual({ ready: true });
  });
});

describe.each([
  {
    title: "Zoom",
    plugin: zoomMeetingsPlugin,
    url: "https://zoom.us/j/12345678903?pwd=node",
    tabId: "zoom-tab",
    nodeCommand: "zoommeetings.chrome",
    admissionReason: "zoom-admission-required",
    preserveTrackedBrowser: true,
  },
  {
    title: "Teams",
    plugin: teamsMeetingsPlugin,
    url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_node_resume%40thread.v2/0",
    tabId: "teams-tab",
    nodeCommand: "teamsmeetings.chrome",
    admissionReason: "teams-admission-required",
    preserveTrackedBrowser: false,
  },
])("$title browser meeting audio", (entry) => {
  const { plugin } = entry;
  if (plugin === zoomMeetingsPlugin) {
    describe("startup cleanup", () => {
      defineMeetingChromeCleanupTests({
        ...entry,
        resolveConfig: plugin.config.resolveConfig,
        launchInChrome: plugin.chrome.launchInChrome,
        launchOnNode: plugin.chrome.launchOnNode,
        engineMocks,
      });
    });
  }

  describe("node realtime recovery", () => {
    const testState = useMeetingTestState(createOpenClawTestState);

    it("starts the node bridge after manual admission becomes route-ready", async () => {
      const engines: Array<{ getHealth(): { bridgeClosed: boolean }; stop(): Promise<void> }> = [];
      engineMocks.speak.mockReset();
      engineMocks.startAgent
        .mockReset()
        .mockImplementation(async ({ transport }: { transport: { stop(): Promise<void> } }) => {
          const health = { bridgeClosed: false };
          const engine = {
            getHealth: () => health,
            providerId: "test",
            speak: engineMocks.speak,
            stop: () => transport.stop(),
          };
          engines.push(engine);
          return engine;
        });
      const harness = createMeetingNodeBrowserFixture({
        ...entry,
        status: (state) =>
          state.inCall
            ? {
                audioInputRouted: true,
                audioOutputRouted: true,
                inCall: true,
                micMuted: false,
                url: state.tabUrl,
              }
            : {
                inCall: false,
                manualAction: { reason: entry.admissionReason, message: "Waiting for admission" },
                url: state.tabUrl,
              },
      });
      harness.state.inCall = false;
      const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
      const isZoom = plugin === zoomMeetingsPlugin;
      const runtime = new plugin.Runtime({
        config: plugin.config.resolveConfig({
          chrome: { waitForInCallMs: 1 },
          chromeNode: { node: "node-1" },
          ...(isZoom ? { realtime: { agentId: "consult" } } : {}),
        }),
        fullConfig: {},
        logger,
        runtime: harness.runtime,
      });
      testState.track(runtime, { readWarnings: () => logger.warn.mock.calls });

      const joined = await runtime.join({
        ...(isZoom ? { agentId: "support" } : {}),
        mode: "agent",
        requesterSessionKey: "agent:support:session:caller",
        transport: "chrome-node",
        url: entry.url,
      });
      expect(joined.session.chrome?.audioBridge).toBeUndefined();
      harness.state.inCall = true;

      expect((await runtime.speak(joined.session.id, "hello")).spoken).toBe(true);
      expect(engineMocks.startAgent).toHaveBeenCalledTimes(1);
      expect(engineMocks.startAgent).toHaveBeenCalledWith(
        expect.objectContaining({ requesterSessionKey: "agent:support:session:caller" }),
      );
      expect(engineMocks.speak).toHaveBeenCalledWith("hello");
      expect(joined.session.chrome?.audioBridge).toMatchObject({ type: "node-command-pair" });

      if (isZoom) {
        expect(joined.session.agentId).toBe("support");
        expect(engineMocks.startAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            config: expect.objectContaining({
              realtime: expect.objectContaining({ agentId: "support" }),
            }),
          }),
        );
        const firstEngine = engines[0];
        if (!firstEngine) {
          throw new Error("Expected the initial meeting engine");
        }
        await firstEngine.stop();
        firstEngine.getHealth().bridgeClosed = true;
        await runtime.status(joined.session.id);
        expect((await runtime.speak(joined.session.id, "again")).spoken).toBe(true);
        expect(engineMocks.startAgent).toHaveBeenCalledTimes(2);
        expect(engineMocks.speak).toHaveBeenCalledWith("again");
        expect(joined.session.chrome?.health?.bridgeClosed).toBe(false);
      }
      expect(harness.state.audioCaptureId).toEqual(expect.any(String));
      await runtime.leave(joined.session.id);
      expect(harness.state.audioCaptureId).toBeUndefined();
    });
  });
});
