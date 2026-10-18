import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingPlatformAdapter } from "./platform-adapter.js";
import { createMeetingRuntimeProbes, resolveMeetingProbeTimeoutMs } from "./runtime-probes.js";
import type { MeetingPluginProbeHealth } from "./session-types.js";

type Session = {
  id: string;
  chrome?: {
    launched: boolean;
    health?: MeetingPluginProbeHealth;
  };
};
type CreateProbeOptions = {
  invalidRequest?: (message: string) => Error;
  shouldWaitForListening?: (session: Session) => boolean;
};

const URL = "https://example.test/meeting";
const config = { defaultMode: "agent" as const, chrome: { joinTimeoutMs: 30_000 }, chromeNode: {} };
const listenRequest = { url: URL, mode: "transcribe" as const, timeoutMs: 100 };
const speechRequest = { url: URL, mode: "agent" as const };

function createSession(id: string, health: MeetingPluginProbeHealth = {}): Session {
  return { id, chrome: { launched: true, health } };
}

function createProbes(options: CreateProbeOptions = {}) {
  return createMeetingRuntimeProbes<
    typeof config,
    "agent" | "bidi" | "transcribe",
    "chrome" | "chrome-node",
    MeetingPluginProbeHealth,
    Session,
    { url: string; mode?: "agent" | "bidi" | "transcribe"; timeoutMs?: number }
  >({
    defaultSpeechMessage: "Say exactly: meeting speech test complete.",
    invalidRequest: options.invalidRequest ?? ((message) => new Error(message)),
    resolveTimeoutMs: resolveMeetingProbeTimeoutMs,
    shouldWaitForListening: options.shouldWaitForListening ?? (() => true),
    talkBackMode: MeetingPlatformAdapter.isTalkBackMode,
  });
}

type ProbeContext = Parameters<ReturnType<typeof createProbes>["testSpeech"]>[0];

function createContext(params: {
  session: Session;
  spoken?: boolean;
  hasHealthHandle?: boolean;
  refreshHealth?: () => void;
  refreshCaptionHealth?: (session: Session, timeoutMs?: number) => Promise<void>;
}): ProbeContext {
  return {
    config,
    resolveAgentId: () => "main",
    list: () => [],
    join: vi.fn(async () => ({ session: params.session, spoken: params.spoken })),
    isReusable: () => false,
    hasHealthHandle: () => params.hasHealthHandle ?? false,
    refreshHealth: params.refreshHealth ?? vi.fn(),
    refreshCaptionHealth: params.refreshCaptionHealth ?? vi.fn(async () => undefined),
  };
}

afterEach(() => vi.useRealTimers());

describe("meeting runtime probes", () => {
  it("uses the supplied invalid-request factory", async () => {
    const probes = createProbes({
      invalidRequest: (message) =>
        Object.assign(new Error(message), { name: "ProbeInvalidRequest" }),
    });

    await expect(
      probes.testSpeech(createContext({ session: { id: "unused" } }), listenRequest),
    ).rejects.toMatchObject({
      name: "ProbeInvalidRequest",
      message: "test_speech requires mode: agent or bidi",
    });
  });

  it("uses the per-request speech verification timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createSession("speech-timeout", { inCall: true, lastOutputBytes: 0 });
    const refreshHealth = vi.fn();
    const probes = createProbes();

    const pending = probes.testSpeech(
      createContext({ session, spoken: true, hasHealthHandle: true, refreshHealth }),
      { ...speechRequest, timeoutMs: 150 },
    );
    await vi.advanceTimersByTimeAsync(200);

    await expect(pending).resolves.toMatchObject({ speechOutputTimedOut: true });
    expect(refreshHealth).toHaveBeenCalled();
  });

  it("requires a fresh verified output generation", async () => {
    const probes = createProbes();
    for (const [verifiedOutputGeneration, expected] of [
      [undefined, false],
      [1, true],
    ] as const) {
      const session = createSession(`speech-generation-${String(verifiedOutputGeneration)}`, {
        inCall: true,
        lastOutputBytes: 4,
        outputGeneration: 1,
        verifiedOutputGeneration,
      });

      const result = await probes.testSpeech(
        createContext({ session, spoken: true }),
        speechRequest,
      );

      expect(result.speechOutputVerified).toBe(expected);
    }
  });

  it.each([false, true])(
    "returns manual action with caption progress=%s before the deadline",
    async (captions) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const session = createSession("listen-progress");
      const manualAction = { reason: "admission-required", message: "Waiting" };
      const refreshCaptionHealth = vi.fn(async () => {
        session.chrome!.health = {
          manualAction,
          ...(captions ? { lastCaptionText: "Caption already waiting", transcriptLines: 1 } : {}),
        };
      });
      const probes = createProbes({ shouldWaitForListening: () => true });
      const result = await probes.testListening(
        createContext({ session, refreshCaptionHealth }),
        listenRequest,
      );
      expect(result).toMatchObject({ listenVerified: captions, manualAction });
      expect(refreshCaptionHealth).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects caption progress that arrives after the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createSession("listen-late");
    const probes = createProbes();
    const refreshCaptionHealth = async (_session: Session, timeoutMs?: number) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, (timeoutMs ?? 0) + 50);
      });
      session.chrome!.health = { lastCaptionText: "Too late", transcriptLines: 1 };
    };

    const pending = probes.testListening(createContext({ session, refreshCaptionHealth }), {
      ...listenRequest,
      timeoutMs: 300,
    });
    await vi.advanceTimersByTimeAsync(400);

    await expect(pending).resolves.toMatchObject({ listenTimedOut: true, listenVerified: false });
  });
});
