import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MeetingPlatformAdapter } from "./platform-adapter.js";
import { createMeetingRuntimeProbes, resolveMeetingProbeTimeoutMs } from "./runtime-probes.js";
import type { MeetingPluginProbeHealth, MeetingPluginSession } from "./session-types.js";

type Session = Pick<
  MeetingPluginSession<string, string, MeetingPluginProbeHealth>,
  "id" | "chrome"
>;

const URL = "https://example.test/meeting";
const config = { defaultMode: "agent" as const, chrome: { joinTimeoutMs: 30_000 }, chromeNode: {} };
const listenRequest = { url: URL, mode: "transcribe" as const, timeoutMs: 100 };
const speechRequest = { url: URL, mode: "agent" as const };

function createSession(id: string, health: MeetingPluginProbeHealth = {}): Session {
  return { id, chrome: { launched: true, health } };
}

const probes = createMeetingRuntimeProbes<
  typeof config,
  "agent" | "bidi" | "transcribe",
  "chrome" | "chrome-node",
  MeetingPluginProbeHealth,
  Session,
  { url: string; mode?: "agent" | "bidi" | "transcribe"; timeoutMs?: number }
>({
  defaultSpeechMessage: "Say exactly: meeting speech test complete.",
  invalidRequest: (message) => Object.assign(new Error(message), { name: "ProbeInvalidRequest" }),
  resolveTimeoutMs: resolveMeetingProbeTimeoutMs,
  shouldWaitForListening: () => true,
  talkBackMode: MeetingPlatformAdapter.isTalkBackMode,
});

type ProbeContext = Parameters<typeof probes.testSpeech>[0];

function createContext(
  session: Session,
  overrides: Partial<ProbeContext> = {},
  spoken?: boolean,
): ProbeContext {
  return {
    config,
    resolveAgentId: () => "main",
    list: () => [],
    join: vi.fn(async () => ({ session, spoken })),
    isReusable: () => false,
    hasHealthHandle: () => false,
    refreshHealth: vi.fn(),
    refreshCaptionHealth: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => vi.useFakeTimers({ now: 0 }));
afterEach(() => vi.useRealTimers());

it.each([
  ["transcribe", undefined, false, false],
  ["agent", undefined, false, false],
  ["agent", 1, true, false],
  ["agent", undefined, false, true],
] as const)(
  "checks %s generation=%s, verified=%s, timeout=%s",
  async (mode, generation, verified, timeout) => {
    if (mode === "transcribe") {
      await expect(
        probes.testSpeech(createContext({ id: "unused" }), listenRequest),
      ).rejects.toMatchObject({
        name: "ProbeInvalidRequest",
        message: "test_speech requires mode: agent or bidi",
      });
      return;
    }
    const session = createSession("speech", {
      inCall: true,
      lastOutputBytes: timeout ? 0 : 4,
      ...(timeout ? {} : { outputGeneration: 1, verifiedOutputGeneration: generation }),
    });
    const refreshHealth = vi.fn();
    const pending = probes.testSpeech(
      createContext(session, { hasHealthHandle: () => timeout, refreshHealth }, true),
      { ...speechRequest, ...(timeout ? { timeoutMs: 150 } : {}) },
    );
    if (timeout) {
      await vi.advanceTimersByTimeAsync(200);
    }
    expect((await pending).speechOutputVerified).toBe(verified);
    if (timeout) {
      await expect(pending).resolves.toMatchObject({ speechOutputTimedOut: true });
      expect(refreshHealth).toHaveBeenCalled();
    }
  },
);

it("returns caption progress with manual action before the deadline", async () => {
  const session = createSession("listen-progress");
  const manualAction = { reason: "admission-required", message: "Waiting" };
  const refreshCaptionHealth = vi.fn(async () => {
    session.chrome!.health = {
      manualAction,
      lastCaptionText: "Caption already waiting",
      transcriptLines: 1,
    };
  });
  const result = await probes.testListening(
    createContext(session, { refreshCaptionHealth }),
    listenRequest,
  );
  expect(result).toMatchObject({ listenVerified: true, manualAction });
  expect(refreshCaptionHealth).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects caption progress that arrives after the deadline", async () => {
  const session = createSession("listen-late");
  const refreshCaptionHealth = async (_session: Session, timeoutMs?: number) => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, (timeoutMs ?? 0) + 50);
    });
    session.chrome!.health = { lastCaptionText: "Too late", transcriptLines: 1 };
  };

  const pending = probes.testListening(createContext(session, { refreshCaptionHealth }), {
    ...listenRequest,
    timeoutMs: 300,
  });
  await vi.advanceTimersByTimeAsync(400);

  await expect(pending).resolves.toMatchObject({ listenTimedOut: true, listenVerified: false });
});
