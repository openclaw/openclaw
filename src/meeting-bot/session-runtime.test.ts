import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { TranscriptsStore } from "../transcripts/store.js";
import { createMeetingSession } from "./session-factory.js";
import {
  getMeetingSessionRuntimeProbeAccess,
  registerMeetingSessionRuntimeHealthRefresh,
  type MeetingBrowserHealthRefreshOutcome,
} from "./session-runtime-probes.js";
import {
  MeetingSessionRuntime,
  type MeetingSessionRuntimeJoinContext,
  type MeetingSessionRuntimeOptions,
} from "./session-runtime.js";
import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingSessionRecord,
} from "./session-types.js";

type TestTransport = "chrome";
type TestMode = "agent";
type TestRequest = { url: string; agentId: string };
type TestSession = MeetingSessionRecord<TestTransport, TestMode> & {
  browser?: {
    launched: boolean;
    tab?: MeetingBrowserTab;
    health?: MeetingBrowserHealth;
    hasAudioBridge?: boolean;
  };
};
type TestJoinContext = MeetingSessionRuntimeJoinContext<
  TestSession,
  TestTransport,
  TestMode,
  MeetingBrowserHealth,
  MeetingBrowserTab
>;

describe("createMeetingSession", () => {
  it.each([
    {
      mode: "agent" as const,
      provider: undefined,
      transcriptionProvider: "deepgram",
    },
    {
      mode: "bidi" as const,
      provider: "openai-realtime",
      transcriptionProvider: undefined,
    },
  ])("preserves $mode realtime session fields", ({ mode, provider, transcriptionProvider }) => {
    const session = createMeetingSession({
      platform: {
        id: "test-meeting",
        displayName: "Test Meeting",
        logScope: "[test-meeting]",
        agentConsult: {
          surface: "a test meeting",
          userLabel: "Participant",
          assistantLabel: "Agent",
          questionSourceLabel: "participant",
          workingResponseLabel: "participant",
          extraSystemPrompt: "Answer briefly.",
        },
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
        mode,
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
        strategy: mode,
        provider,
        model: mode === "bidi" ? "realtime-model" : undefined,
        transcriptionProvider,
        toolPolicy: "safe-read-only",
      },
      notes: [],
    });
  });
});

function createTestRuntime(params: {
  captureTranscript?: (options?: { finalize?: boolean }) => Promise<
    | {
        droppedLines: number;
        epoch?: string;
        lines: Array<{ at?: string; speaker?: string; text: string }>;
      }
    | undefined
  >;
  durableTranscripts?: { stateDir: string };
  talkBack?: boolean;
  transcribe?: boolean;
  refreshReusableSession?(
    session: TestSession,
    request: TestRequest,
    resolved: { agentId: string; mode: TestMode; transport: TestTransport; url: string },
  ): Promise<{ keepBrowserTab: boolean } | void>;
  refreshBrowserHealth?(
    session: TestSession,
    options?: { force?: boolean; readOnly?: boolean; timeoutMs?: number; deadline?: number },
  ): Promise<MeetingBrowserHealthRefreshOutcome | boolean | void>;
  refreshStatus?(session: TestSession): Promise<void>;
  joinTransport(input: {
    request: TestRequest;
    session: TestSession;
    context: TestJoinContext;
  }): Promise<{ delegatedSpoken?: boolean }>;
  releaseBrowserTab(session: TestSession): Promise<boolean | undefined>;
}) {
  let nextSessionId = 0;
  const createdSessions: TestSession[] = [];
  const runtime = new MeetingSessionRuntime<
    TestSession,
    TestRequest,
    TestTransport,
    TestMode,
    MeetingBrowserHealth,
    MeetingBrowserTab,
    string,
    string
  >({
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    logScope: "[meeting-test]",
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    messages: {
      previousBrowserLeaveFailed: "previous leave failed",
      reassignedSessionNote: "reassigned",
      reusedSessionNote: "reused",
      replacementBrowserLeaveFailed: "replacement leave failed",
      speechBlockedFallback: "speech blocked",
      speech: {
        audioBridgeUnavailable: "bridge unavailable",
        browserUnverified: "browser unverified",
        microphoneMuted: "microphone muted",
        microphoneMutedReason: "microphone-muted",
        notInCall: "not in call",
        notInCallReason: "not-in-call",
        browserUnverifiedReason: "browser-unverified",
        audioBridgeUnavailableReason: "bridge-unavailable",
      },
    },
    reuseExistingBrowserTab: true,
    waitForInCallMs: 1,
    joinTimeoutMs: 1,
    transientSpeechBlockedReasons: new Set<string>(),
    resolveJoin: (request) => ({
      url: request.url,
      transport: "chrome",
      mode: "agent",
      agentId: request.agentId,
    }),
    createSession: ({ resolved, createdAt }) => {
      const session: TestSession = {
        id: `session-${++nextSessionId}`,
        ...resolved,
        state: "active",
        createdAt,
        updatedAt: createdAt,
        participantIdentity: "OpenClaw",
        realtime: { enabled: false, toolPolicy: "none" },
        notes: [],
      };
      createdSessions.push(session);
      return session;
    },
    resolveSpeechInstructions: () => undefined,
    isBrowserTransport: () => true,
    isTalkBackMode: () => params.talkBack === true,
    isTranscribeMode: () => params.transcribe === true,
    sameMeetingUrl: (left, right) => left === right,
    normalizeMeetingUrlForReuse: (url) => url,
    getBrowser: (session) =>
      session.browser
        ? {
            launched: session.browser.launched,
            tab: session.browser.tab,
            health: session.browser.health,
            hasAudioBridge: session.browser.hasAudioBridge === true,
          }
        : undefined,
    setBrowserTab: (session, tab) => {
      if (session.browser) {
        session.browser.tab = tab;
      }
    },
    setBrowserHealth: (session, health) => {
      if (session.browser) {
        session.browser.health = health;
      }
    },
    joinTransport: (input) => params.joinTransport(input),
    releaseBrowserTab: (session) => params.releaseBrowserTab(session),
    refreshBrowserHealth: async (session, options) => {
      await params.refreshBrowserHealth?.(session, options);
    },
    refreshStatus: async (session) => await params.refreshStatus?.(session),
    refreshReusableSession: async (session, request, resolved) =>
      await params.refreshReusableSession?.(session, request, resolved),
    ensureRealtimeBridge: async () => undefined,
    captureTranscript: async (_session, options) => await params.captureTranscript?.(options),
    speakViaTransport: async () => undefined,
    ...(params.durableTranscripts
      ? {
          durableTranscripts: {
            providerId: "test-meeting",
            providerName: "Test Meeting",
            stateDir: params.durableTranscripts.stateDir,
          },
        }
      : {}),
  });
  registerMeetingSessionRuntimeHealthRefresh(runtime, async (session: TestSession, options) => {
    const result = await params.refreshBrowserHealth?.(session, options);
    if (result !== null && typeof result === "object") {
      return result;
    }
    const browserHealthChecked = result === true;
    return {
      browserHealthChecked,
      manualActionIsAuthoritative: browserHealthChecked,
    };
  });
  return { createdSessions, runtime };
}

describe("MeetingSessionRuntime probe join health", () => {
  it.each([
    {
      launched: true,
      refreshResult: true,
      reusedBrowserHealthChecked: true,
      reusedManualActionIsAuthoritative: true,
      refreshCalls: 1,
    },
    {
      launched: true,
      refreshResult: false,
      reusedBrowserHealthChecked: false,
      reusedManualActionIsAuthoritative: false,
      refreshCalls: 1,
    },
    {
      launched: true,
      refreshResult: undefined,
      reusedBrowserHealthChecked: false,
      reusedManualActionIsAuthoritative: false,
      refreshCalls: 1,
    },
    {
      launched: true,
      refreshResult: {
        browserHealthChecked: false,
        manualActionIsAuthoritative: true,
      },
      reusedBrowserHealthChecked: false,
      reusedManualActionIsAuthoritative: true,
      refreshCalls: 1,
    },
    {
      launched: false,
      refreshResult: true,
      reusedBrowserHealthChecked: false,
      reusedManualActionIsAuthoritative: false,
      refreshCalls: 0,
    },
  ])(
    "reports the closed refresh outcome when launched=$launched and refresh returns $refreshResult",
    async ({
      launched,
      refreshResult,
      reusedBrowserHealthChecked,
      reusedManualActionIsAuthoritative,
      refreshCalls,
    }) => {
      const refreshBrowserHealth = vi.fn(async () => refreshResult);
      const { runtime } = createTestRuntime({
        refreshBrowserHealth,
        releaseBrowserTab: async () => true,
        joinTransport: async ({ session }) => {
          session.browser = {
            launched,
            tab: { targetId: "probe-tab", openedByPlugin: launched },
          };
          return {};
        },
      });

      const probeAccess = getMeetingSessionRuntimeProbeAccess<TestSession, TestRequest>(runtime);
      const first = await probeAccess.joinForProbe({
        url: "https://meeting.example/probe",
        agentId: "main",
      });
      const reused = await probeAccess.joinForProbe({
        url: "https://meeting.example/probe",
        agentId: "main",
      });

      expect(first.browserHealthChecked).toBe(true);
      expect(first.manualActionIsAuthoritative).toBe(true);
      expect(reused.browserHealthChecked).toBe(reusedBrowserHealthChecked);
      expect(reused.manualActionIsAuthoritative).toBe(reusedManualActionIsAuthoritative);
      expect(refreshBrowserHealth).toHaveBeenCalledTimes(refreshCalls);
    },
  );

  it.each([
    { tracked: true, refreshCalls: 1 },
    { tracked: false, refreshCalls: 0 },
  ])(
    "force-refreshes a launch-disabled browser session when tracked=$tracked",
    async ({ tracked, refreshCalls }) => {
      const refreshBrowserHealth = vi.fn(async () => true);
      const { runtime } = createTestRuntime({
        refreshBrowserHealth,
        releaseBrowserTab: async () => true,
        joinTransport: async ({ session }) => {
          session.browser = {
            launched: false,
            tab: tracked ? { targetId: "manual-tab", openedByPlugin: false } : undefined,
          };
          return {};
        },
      });
      const { session } = await runtime.join({
        url: "https://meeting.example/manual",
        agentId: "main",
      });
      refreshBrowserHealth.mockClear();

      await runtime.refreshBrowserHealth(session, { force: true });

      expect(refreshBrowserHealth).toHaveBeenCalledTimes(refreshCalls);
      if (tracked) {
        expect(refreshBrowserHealth).toHaveBeenCalledWith(session, { force: true });
      }
    },
  );
});

describe("MeetingSessionRuntime caption health compatibility", () => {
  it("keeps the owner refresh callback on the public void contract", () => {
    type TestRuntimeOptions = MeetingSessionRuntimeOptions<
      TestSession,
      TestRequest,
      TestTransport,
      TestMode,
      MeetingBrowserHealth,
      MeetingBrowserTab,
      string,
      string
    >;

    expectTypeOf<ReturnType<TestRuntimeOptions["refreshBrowserHealth"]>>().toEqualTypeOf<
      Promise<void>
    >();
  });

  it("keeps the legacy void method while exposing the probe refresh outcome", async () => {
    const refreshOutcome = {
      browserHealthChecked: false,
      manualActionIsAuthoritative: true,
    } as const;
    const refreshBrowserHealth = vi.fn(
      async (
        _session: TestSession,
        _options?: { force?: boolean; readOnly?: boolean; timeoutMs?: number; deadline?: number },
      ) => refreshOutcome,
    );
    const { runtime } = createTestRuntime({
      transcribe: true,
      refreshBrowserHealth,
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "caption-tab", openedByPlugin: true },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/captions",
      agentId: "main",
    });
    refreshBrowserHealth.mockClear();

    const legacyRefresh: (session: TestSession) => Promise<void> =
      runtime.refreshCaptionHealth.bind(runtime);
    await expect(legacyRefresh(session)).resolves.toBeUndefined();
    const deadline = Date.now() + 125;
    await expect(
      getMeetingSessionRuntimeProbeAccess<TestSession, TestRequest>(
        runtime,
      ).refreshCaptionHealthForProbe(session, deadline),
    ).resolves.toEqual(refreshOutcome);
    expect(refreshBrowserHealth).toHaveBeenCalledTimes(2);
    expect(refreshBrowserHealth.mock.calls[0]?.[1]).toEqual({});
    expect(refreshBrowserHealth.mock.calls[1]?.[1]).toEqual({ force: true, deadline });
  });

  it("serializes probe and lifecycle browser refreshes", async () => {
    let releaseFirstRefresh!: () => void;
    let markFirstRefreshStarted!: () => void;
    const firstRefreshStarted = new Promise<void>((resolve) => {
      markFirstRefreshStarted = resolve;
    });
    const firstRefreshReleased = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;
    const refreshBrowserHealth = vi.fn(async () => {
      activeRefreshes += 1;
      maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
      if (refreshBrowserHealth.mock.calls.length === 1) {
        markFirstRefreshStarted();
        await firstRefreshReleased;
      }
      activeRefreshes -= 1;
      return { browserHealthChecked: true, manualActionIsAuthoritative: true } as const;
    });
    const { runtime } = createTestRuntime({
      transcribe: true,
      refreshBrowserHealth,
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: false,
          tab: { targetId: "retained-caption-tab", openedByPlugin: false },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/serialized-captions",
      agentId: "main",
    });

    const lifecycleRefresh = runtime.refreshBrowserHealth(session, { force: true });
    await firstRefreshStarted;
    const deadline = Date.now() + 250;
    const probeRefresh = getMeetingSessionRuntimeProbeAccess<TestSession, TestRequest>(
      runtime,
    ).refreshCaptionHealthForProbe(session, deadline);
    await Promise.resolve();

    expect(refreshBrowserHealth).toHaveBeenCalledTimes(1);
    releaseFirstRefresh();
    await Promise.all([lifecycleRefresh, probeRefresh]);

    expect(maxActiveRefreshes).toBe(1);
    expect(refreshBrowserHealth).toHaveBeenNthCalledWith(1, session, { force: true });
    expect(refreshBrowserHealth).toHaveBeenNthCalledWith(2, session, {
      force: true,
      deadline,
    });
  });

  it("does not run a queued probe after its tab begins reassignment", async () => {
    let releaseFirstRefresh!: () => void;
    let markFirstRefreshStarted!: () => void;
    const firstRefreshStarted = new Promise<void>((resolve) => {
      markFirstRefreshStarted = resolve;
    });
    const firstRefreshReleased = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    let releaseFinalCapture!: () => void;
    let markFinalCaptureStarted!: () => void;
    const finalCaptureStarted = new Promise<void>((resolve) => {
      markFinalCaptureStarted = resolve;
    });
    const finalCaptureReleased = new Promise<void>((resolve) => {
      releaseFinalCapture = resolve;
    });
    let releaseReplacementTransport!: () => void;
    let markReplacementTransportStarted!: () => void;
    const replacementTransportStarted = new Promise<void>((resolve) => {
      markReplacementTransportStarted = resolve;
    });
    const replacementTransportReleased = new Promise<void>((resolve) => {
      releaseReplacementTransport = resolve;
    });
    const refreshBrowserHealth = vi.fn(async () => {
      if (refreshBrowserHealth.mock.calls.length === 1) {
        markFirstRefreshStarted();
        await firstRefreshReleased;
      }
      return { browserHealthChecked: true, manualActionIsAuthoritative: true } as const;
    });
    const { runtime } = createTestRuntime({
      transcribe: true,
      captureTranscript: async (options) => {
        if (options?.finalize) {
          markFinalCaptureStarted();
          await finalCaptureReleased;
        }
        return { droppedLines: 0, lines: [] };
      },
      refreshBrowserHealth,
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session, context }) => {
        if (session.agentId === "main") {
          markReplacementTransportStarted();
          await replacementTransportReleased;
        }
        session.browser = {
          launched: false,
          tab: context.inheritedBrowserTab({
            meetingUrl: session.url,
            tab: { targetId: "reassigned-caption-tab", openedByPlugin: false },
            transport: session.transport,
          }),
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/reassigned-captions",
      agentId: "support",
    });

    const firstRefresh = runtime.refreshBrowserHealth(session, { force: true });
    await firstRefreshStarted;
    const replacement = runtime.join({
      url: "https://meeting.example/reassigned-captions",
      agentId: "main",
    });
    expect(session.state).toBe("active");
    releaseFirstRefresh();
    await firstRefresh;
    await finalCaptureStarted;
    const queuedProbe = getMeetingSessionRuntimeProbeAccess<TestSession, TestRequest>(
      runtime,
    ).refreshCaptionHealthForProbe(session, Date.now() + 250);

    releaseFinalCapture();
    await replacementTransportStarted;
    await queuedProbe;
    expect(refreshBrowserHealth).toHaveBeenCalledOnce();
    releaseReplacementTransport();
    const replacementResult = await replacement;

    expect(refreshBrowserHealth).toHaveBeenCalledOnce();
    expect(session.state).toBe("ended");
    expect(session.browser?.tab).toBeUndefined();
    expect(replacementResult.session.browser?.tab?.targetId).toBe("reassigned-caption-tab");
  });
});

describe("MeetingSessionRuntime status cleanup ordering", () => {
  it("does not refresh ended sessions by id or through the list", async () => {
    const refreshStatus = vi.fn(async () => {});
    const { runtime } = createTestRuntime({
      refreshStatus,
      releaseBrowserTab: async (session) => {
        if (session.browser) {
          session.browser.tab = undefined;
        }
        return true;
      },
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "terminal-tab", openedByPlugin: true },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/terminal",
      agentId: "main",
    });
    await runtime.leave(session.id);

    await expect(runtime.status(session.id)).resolves.toMatchObject({
      found: true,
      session: { state: "ended", browserLeft: true },
    });
    await expect(runtime.status()).resolves.toMatchObject({
      found: true,
      sessions: [{ state: "ended", browserLeft: true }],
    });
    expect(refreshStatus).not.toHaveBeenCalled();
  });

  it("preserves terminal speech health when an in-flight status refresh finishes late", async () => {
    let finishRefresh!: () => void;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const refreshFinished = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    let runtime!: ReturnType<typeof createTestRuntime>["runtime"];
    ({ runtime } = createTestRuntime({
      refreshBrowserHealth: async () => {
        markRefreshStarted();
        await refreshFinished;
        return false;
      },
      refreshStatus: async (session) => {
        await runtime.refreshBrowserHealth(session, { force: true });
      },
      releaseBrowserTab: async (session) => {
        if (session.browser) {
          session.browser.tab = undefined;
        }
        return true;
      },
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "late-refresh-tab", openedByPlugin: true },
          health: { inCall: true, micMuted: false, speechReady: true },
        };
        return {};
      },
    }));
    const { session } = await runtime.join({
      url: "https://meeting.example/late-status-refresh",
      agentId: "main",
    });

    const status = runtime.status(session.id);
    await refreshStarted;
    const leaving = runtime.leave(session.id);
    expect(session.state).toBe("active");

    finishRefresh();
    const [, leaveResult] = await Promise.all([status, leaving]);
    expect(leaveResult).toMatchObject({
      browserLeft: true,
      session: { state: "ended" },
    });
    await expect(status).resolves.toMatchObject({
      found: true,
      session: { state: "ended" },
    });
    expect(session.browser?.health).toMatchObject({ inCall: false, speechReady: false });
  });

  it("releases a tab recovered before terminal transcript capture", async () => {
    let finishFinalCapture!: () => void;
    let markFinalCaptureStarted!: () => void;
    const finalCaptureStarted = new Promise<void>((resolve) => {
      markFinalCaptureStarted = resolve;
    });
    const finalCaptureFinished = new Promise<void>((resolve) => {
      finishFinalCapture = resolve;
    });
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { runtime } = createTestRuntime({
      transcribe: true,
      captureTranscript: async (options) => {
        if (options?.finalize) {
          markFinalCaptureStarted();
          await finalCaptureFinished;
        }
        return { droppedLines: 0, lines: [] };
      },
      refreshBrowserHealth: async (session) => {
        session.browser!.tab = { targetId: "recovered-tab", openedByPlugin: false };
        return true;
      },
      releaseBrowserTab,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "stale-tab", openedByPlugin: false },
        };
        session.browserLeft = true;
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/recovered-during-leave",
      agentId: "main",
    });

    const refreshing = runtime.refreshBrowserHealth(session, { force: true });
    const leaving = runtime.leave(session.id);
    await refreshing;
    await finalCaptureStarted;
    finishFinalCapture();

    await expect(leaving).resolves.toMatchObject({
      browserLeft: true,
      session: { state: "ended", browserLeft: true },
    });
    expect(releaseBrowserTab).toHaveBeenCalledOnce();
    expect(session.browser?.tab).toBeUndefined();
  });

  it("serializes overlapping browser recovery before terminal cleanup", async () => {
    let finishOlderRefresh!: () => void;
    let markOlderRefreshStarted!: () => void;
    const olderRefreshStarted = new Promise<void>((resolve) => {
      markOlderRefreshStarted = resolve;
    });
    const olderRefreshFinished = new Promise<void>((resolve) => {
      finishOlderRefresh = resolve;
    });
    let refreshCalls = 0;
    const refreshBrowserHealth = vi.fn(async (session: TestSession) => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        markOlderRefreshStarted();
        await olderRefreshFinished;
        session.browser!.tab = undefined;
        session.browserLeft = true;
        return false;
      }
      session.browser!.tab = { targetId: "replacement-tab", openedByPlugin: false };
      session.browserLeft = undefined;
      return true;
    });
    const releasedTargetIds: Array<string | undefined> = [];
    const { runtime } = createTestRuntime({
      refreshBrowserHealth,
      releaseBrowserTab: async (session) => {
        releasedTargetIds.push(session.browser?.tab?.targetId);
        if (session.browser) {
          session.browser.tab = undefined;
        }
        return true;
      },
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "original-tab", openedByPlugin: false },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/overlapping-recovery",
      agentId: "main",
    });

    const olderRefresh = runtime.refreshBrowserHealth(session, { force: true });
    await olderRefreshStarted;
    const newerRefresh = runtime.refreshBrowserHealth(session, { force: true });
    await Promise.resolve();
    const callsWhileOlderRefreshWasPending = refreshBrowserHealth.mock.calls.length;
    finishOlderRefresh();
    await Promise.all([olderRefresh, newerRefresh]);

    expect(callsWhileOlderRefreshWasPending).toBe(1);
    expect(session.browserLeft).toBeUndefined();
    expect(session.browser?.tab?.targetId).toBe("replacement-tab");

    await runtime.leave(session.id);

    expect(releasedTargetIds).toEqual(["replacement-tab"]);
    expect(session.browser?.tab).toBeUndefined();
  });
});

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("MeetingSessionRuntime durable transcripts", () => {
  it("persists joined agent-mode captions and writes summary rows on leave", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-meeting-notes-"));
    tempDirs.push(stateDir);
    const snapshots = [
      {
        droppedLines: 0,
        epoch: "page-1",
        lines: [
          {
            at: "2026-07-23T12:00:00.000Z",
            speaker: "Avery",
            text: "We decided to ship the durable notes bridge.",
          },
        ],
      },
      {
        droppedLines: 0,
        epoch: "page-1",
        lines: [
          {
            at: "2026-07-23T12:00:00.000Z",
            speaker: "Avery",
            text: "We decided to ship the durable notes bridge.",
          },
          {
            at: "2026-07-23T12:00:05.000Z",
            speaker: "Blake",
            text: "Action: follow up with the docs.",
          },
        ],
      },
    ];
    const { runtime } = createTestRuntime({
      captureTranscript: async () => snapshots.shift(),
      durableTranscripts: { stateDir },
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "notes-tab", openedByPlugin: true },
        };
        return {};
      },
    });

    const { session } = await runtime.join({
      url: "https://meeting.example/notes?context=opaque-value",
      agentId: "notes-agent",
    });
    await expect(
      runtime.startTranscriptSource({
        session: {
          sessionId: "external-mismatch",
          source: {
            providerId: "test-meeting",
            agentId: "notes-agent",
            channelId: "another-session",
            meetingUrl: session.url,
          },
          startedAt: session.createdAt,
        },
        onUtterance: vi.fn(),
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      runtime.startTranscriptSource({
        session: {
          sessionId: "external-agent-mismatch",
          source: {
            providerId: "test-meeting",
            agentId: "another-agent",
            meetingUrl: session.url,
          },
          startedAt: session.createdAt,
        },
        onUtterance: vi.fn(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "No active meeting session matches the transcript source.",
    });
    await runtime.leave(session.id);

    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
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
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-meeting-notes-"));
    tempDirs.push(tempDir);
    const blockedStateDir = path.join(tempDir, "not-a-directory");
    await fs.writeFile(blockedStateDir, "blocked", "utf8");
    const captureTranscript = vi.fn(async () => ({ droppedLines: 0, lines: [] }));
    const { runtime } = createTestRuntime({
      captureTranscript,
      durableTranscripts: { stateDir: blockedStateDir },
      transcribe: true,
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "notes-tab", openedByPlugin: true },
        };
        return {};
      },
    });

    const { session } = await runtime.join({
      url: "https://meeting.example/notes",
      agentId: "notes-agent",
    });
    await runtime.leave(session.id);

    expect(captureTranscript).toHaveBeenCalledTimes(2);
    expect(captureTranscript).toHaveBeenCalledWith({ finalize: true });
  });

  it("does not let subscriber delivery failure block meeting leave", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-meeting-notes-"));
    tempDirs.push(stateDir);
    const empty = { droppedLines: 0, epoch: "page-1", lines: [] };
    const final = {
      droppedLines: 0,
      epoch: "page-1",
      lines: [{ speaker: "Avery", text: "Final decision" }],
    };
    const snapshots = [empty, final];
    const releaseBrowserTab = vi.fn(async () => true);
    const { runtime } = createTestRuntime({
      captureTranscript: async () => snapshots.shift(),
      durableTranscripts: { stateDir },
      transcribe: true,
      releaseBrowserTab,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "notes-tab", openedByPlugin: true },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/notes",
      agentId: "notes-agent",
    });
    const onUtterance = vi.fn(async () => {
      throw new Error("subscriber unavailable");
    });
    await runtime.startTranscriptSource({
      session: {
        sessionId: "external-final",
        source: {
          providerId: "test-meeting",
          agentId: "notes-agent",
          meetingUrl: session.url,
        },
        startedAt: session.createdAt,
      },
      onUtterance,
    });

    await expect(runtime.leave(session.id)).resolves.toMatchObject({ found: true });
    expect(session.state).toBe("ended");
    expect(releaseBrowserTab).toHaveBeenCalledOnce();

    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const stored = await store.readSession(session.id);
    expect(await store.readUtterancesForSession(stored!)).toHaveLength(1);
    expect(await store.readSummary(stored!)).toMatchObject({
      summary: { utteranceCount: 1 },
    });
    expect(onUtterance).toHaveBeenCalledOnce();
  });
});

describe("MeetingSessionRuntime failed joins", () => {
  it("cleans an externally ended reusable session before replacing it", async () => {
    const stop = vi.fn(async () => {});
    const releaseBrowserTab = vi.fn(async () => true);
    const joinTransport = vi.fn(
      async ({ session, context }: { session: TestSession; context: TestJoinContext }) => {
        session.browser = {
          launched: true,
          tab: { targetId: session.id, openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        return {};
      },
    );
    const { runtime } = createTestRuntime({
      joinTransport,
      refreshReusableSession: async (session) => {
        session.state = "ended";
      },
      releaseBrowserTab,
    });
    const first = await runtime.join({ url: "https://meeting.example/room", agentId: "main" });

    const replacement = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    expect(first.session.state).toBe("ended");
    expect(replacement.session.id).not.toBe(first.session.id);
    expect(stop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).not.toHaveBeenCalled();
    expect(joinTransport).toHaveBeenCalledTimes(2);
  });

  it("stops attached transport handles and releases the partial browser tab", async () => {
    const joinError = new Error("transport setup failed");
    const stop = vi.fn(async () => {});
    let releaseAttempts = 0;
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (releaseAttempts++ === 0) {
        return false;
      }
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { createdSessions, runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "partial-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        throw joinError;
      },
    });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(joinError);

    expect(stop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).toHaveBeenCalledTimes(2);
    expect(createdSessions[0]).toMatchObject({ state: "ended", browser: { tab: undefined } });
    expect(runtime.list()).toEqual([]);
  });

  it("retries transport cleanup for an unpublished failed join", async () => {
    const joinError = new Error("transport setup failed");
    const stopError = new Error("transport stop failed");
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(stopError)
      .mockResolvedValueOnce();
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "partial-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        throw joinError;
      },
    });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(joinError);

    expect(stop).toHaveBeenCalledTimes(2);
    expect(releaseBrowserTab).toHaveBeenCalledOnce();
    expect(runtime.list()).toEqual([]);
  });

  it("retries unprocessed retained tabs after settlement rejects", async () => {
    const settlementError = new Error("retained release rejected");
    const oldStop = vi.fn(async () => {});
    const replacementStop = vi.fn(async () => {});
    const releaseOrder: string[] = [];
    let oldReleaseAttempts = 0;
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      releaseOrder.push(session.id);
      if (session.id === "session-1" && oldReleaseAttempts++ === 0) {
        throw settlementError;
      }
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { createdSessions, runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        const first = session.id === "session-1";
        session.browser = {
          launched: true,
          tab: {
            targetId: first ? "retained-tab" : "replacement-tab",
            openedByPlugin: true,
          },
        };
        context.attachRuntimeHandles(session, { stop: first ? oldStop : replacementStop });
        return {};
      },
    });
    await runtime.join({ url: "https://meeting.example/room", agentId: "support" });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(settlementError);

    expect(oldStop).toHaveBeenCalledOnce();
    expect(replacementStop).toHaveBeenCalledOnce();
    expect(releaseOrder).toEqual(["session-1", "session-2", "session-1"]);
    expect(createdSessions[0]?.browser?.tab).toBeUndefined();
    expect(createdSessions[1]).toMatchObject({ state: "ended", browser: { tab: undefined } });
  });

  it("retries retained cleanup when stopping the previous session rejects", async () => {
    const stopError = new Error("previous transport stop failed");
    const settlementError = new Error("retained release rejected");
    const oldStop = vi.fn(async () => {
      throw stopError;
    });
    let releaseAttempts = 0;
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (releaseAttempts++ === 0) {
        throw settlementError;
      }
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const joinTransport = vi.fn(
      async ({ session, context }: { session: TestSession; context: TestJoinContext }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "retained-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop: oldStop });
        return {};
      },
    );
    const { createdSessions, runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport,
    });
    await runtime.join({ url: "https://meeting.example/room", agentId: "support" });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(stopError);

    expect(joinTransport).toHaveBeenCalledOnce();
    expect(oldStop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).toHaveBeenCalledTimes(2);
    expect(createdSessions[0]).toMatchObject({ state: "ended", browser: { tab: undefined } });
  });
});

describe("MeetingSessionRuntime leave cleanup", () => {
  it("clears stale in-call health after confirmed browser departure", async () => {
    const { runtime } = createTestRuntime({
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          health: {
            inCall: true,
            micMuted: false,
            manualAction: { reason: "old-action", message: "old action" },
            speechReady: true,
            speechBlockedMessage: "old speech block",
            speechBlockedReason: "old-speech-block",
          },
          tab: { targetId: "leave-tab", openedByPlugin: true },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      browserLeft: true,
      session: {
        browser: {
          health: {
            inCall: false,
            manualAction: undefined,
            speechReady: false,
          },
        },
      },
    });
    expect(session.browser?.health?.manualAction).toBeUndefined();
    expect(session.browser?.health?.micMuted).toBeUndefined();
    expect(session.browser?.health?.speechBlockedReason).toBeUndefined();
    expect(session.browser?.health?.speechBlockedMessage).toBeUndefined();
  });

  it("retries a failed transport stop without repeating settled browser cleanup", async () => {
    const stopError = new Error("transport stop failed");
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(stopError)
      .mockResolvedValueOnce();
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
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

    await expect(runtime.leave(session.id)).rejects.toBe(stopError);
    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      found: true,
      browserLeft: true,
    });

    expect(stop).toHaveBeenCalledTimes(2);
    expect(releaseBrowserTab).toHaveBeenCalledOnce();
  });

  it("retries browser cleanup that reported an unsuccessful leave", async () => {
    const stop = vi.fn(async () => {});
    const releaseBrowserTab = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "retry-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      found: true,
      browserLeft: false,
    });
    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      found: true,
      browserLeft: true,
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).toHaveBeenCalledTimes(2);
  });
});

describe("MeetingSessionRuntime speech readiness", () => {
  it("treats an unknown microphone state as transiently unverified", async () => {
    const { runtime } = createTestRuntime({
      talkBack: true,
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          hasAudioBridge: true,
          health: { inCall: true },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

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
