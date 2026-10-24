import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { vi } from "vitest";
import type {
  MeetingParticipationAttempt,
  MeetingParticipationOptions,
} from "./participation-types.js";
import { MeetingSessionRuntime } from "./session-runtime.js";
import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingSessionRecord,
  MeetingTranscriptSnapshot,
} from "./session-types.js";

type TestTransport = "chrome" | "chrome-node";
type TestMode = "agent";
type TestRequest = { url: string; agentId: string };
export type TestSession = MeetingSessionRecord<TestTransport, TestMode> & {
  browser?: {
    launched: boolean;
    nodeId?: string;
    tab?: MeetingBrowserTab;
    health?: MeetingBrowserHealth;
    hasAudioBridge?: boolean;
  };
};
const TestRuntime = MeetingSessionRuntime<
  TestSession,
  TestRequest,
  TestTransport,
  TestMode,
  MeetingBrowserHealth,
  MeetingBrowserTab,
  string,
  string
>;
type RuntimeOptions = ConstructorParameters<typeof TestRuntime>[0];
export type TestJoinContext = Parameters<RuntimeOptions["joinTransport"]>[0]["context"];

export const testBrowser = (
  targetId: string,
  overrides: Partial<NonNullable<TestSession["browser"]>> = {},
) => ({ launched: true, tab: { targetId, openedByPlugin: true }, ...overrides });

export function releaseTab(session: TestSession) {
  if (session.browser) {
    session.browser.tab = undefined;
  }
  return true;
}

export function captionSnapshot(
  lines: MeetingTranscriptSnapshot["lines"],
  options: Pick<MeetingTranscriptSnapshot, "epoch" | "pendingLines"> = {},
): MeetingTranscriptSnapshot {
  return { droppedLines: 0, epoch: "page-1", ...options, lines };
}

export function createTestRuntime(
  params: Pick<RuntimeOptions, "joinTransport" | "releaseBrowserTab"> &
    Partial<
      Pick<RuntimeOptions, "participation" | "refreshReusableSession" | "ensureRealtimeBridge">
    > & {
      captureTranscript?: (options?: {
        finalize?: boolean;
      }) => Promise<MeetingTranscriptSnapshot | undefined>;
      durableTranscripts?: { stateDir: string };
      talkBack?: boolean;
      transcribe?: boolean;
    },
) {
  let nextSessionId = 0;
  const createdSessions: TestSession[] = [];
  const runtime = new TestRuntime({
    participation: params.participation,
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
    resolveJoin: ({ url, agentId }) => ({ url, transport: "chrome", mode: "agent", agentId }),
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
    getBrowser: ({ browser }) =>
      browser && { ...browser, hasAudioBridge: browser.hasAudioBridge === true },
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
    durableTranscripts: params.durableTranscripts && {
      providerId: "test-meeting",
      providerName: "Test Meeting",
      stateDir: params.durableTranscripts.stateDir,
    },
  });
  return { createdSessions, runtime };
}

export function createParticipationTestRuntime(
  params: Pick<
    Parameters<typeof createTestRuntime>[0],
    "captureTranscript" | "transcribe" | "durableTranscripts"
  > = {},
) {
  const rows = new Map<string, MeetingParticipationAttempt>();
  const execute = vi.fn<MeetingParticipationOptions<TestSession>["execute"]>(async () => ({
    status: "succeeded",
  }));
  const store: MeetingParticipationOptions<TestSession>["store"] = {
    lookup: async (key) => rows.get(key),
    register: async (key, value) => {
      rows.set(key, value);
    },
    registerIfAbsent: async (key, value) => {
      if (rows.has(key)) {
        return false;
      }
      rows.set(key, value);
      return true;
    },
    entries: async () => [...rows].map(([key, value]) => ({ key, value, createdAt: 0 })),
    delete: async (key) => rows.delete(key),
  };
  const { runtime } = createTestRuntime({
    ...params,
    participation: {
      store,
      capabilities: () => ["hand.set"],
      validateAction: () => undefined,
      execute,
    },
    joinTransport: async ({ session }) => {
      session.browser = testBrowser("tracked-tab", {
        tab: { targetId: "tracked-tab", openedByPlugin: false },
        health: { inCall: true },
      });
      return {};
    },
    releaseBrowserTab: async () => true,
  });
  return { runtime, store, execute };
}
