import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { vi } from "vitest";
import {
  MeetingSessionRuntime,
  type MeetingSessionRuntimeHandles,
  type MeetingSessionRuntimeJoinContext,
} from "./session-runtime.js";
import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingSessionRecord,
} from "./session-types.js";

type TestTransport = "chrome";
type TestMode = "agent";
type TestRequest = { url: string; agentId: string };
export type TestSession = MeetingSessionRecord<TestTransport, TestMode> & {
  browser?: {
    launched: boolean;
    tab?: MeetingBrowserTab;
    health?: MeetingBrowserHealth;
    hasAudioBridge?: boolean;
  };
};
export type TestJoinContext = MeetingSessionRuntimeJoinContext<
  TestSession,
  TestTransport,
  TestMode,
  MeetingBrowserHealth,
  MeetingBrowserTab
>;

export function createTestRuntime(params: {
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
  joinTransport(input: {
    request: TestRequest;
    session: TestSession;
    context: TestJoinContext;
  }): Promise<{ delegatedSpoken?: boolean }>;
  releaseBrowserTab(session: TestSession): Promise<boolean | undefined>;
  ensureRealtimeBridge?(
    this: void,
    session: TestSession,
  ): Promise<MeetingSessionRuntimeHandles<MeetingBrowserHealth> | undefined>;
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
    formatError: coerceErrorMessage,
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
    refreshBrowserHealth: async () => {},
    refreshStatus: async () => {},
    refreshReusableSession: async (session, request, resolved) =>
      await params.refreshReusableSession?.(session, request, resolved),
    ensureRealtimeBridge: params.ensureRealtimeBridge ?? (async () => undefined),
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
  return { createdSessions, runtime };
}
