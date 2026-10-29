import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RealtimeVoiceBridgeCreateRequest } from "../../src/talk/provider-types.js";
import { awaitGateBeforeSettlement, createDeferred } from "../helpers/promise.js";

const backend = vi.hoisted(() => ({ onFirstAudio: () => {} }));
const browser = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  contextClose: vi.fn(async () => {}),
  googleEvaluate: vi.fn(),
  evaluate: vi.fn(),
}));

vi.mock("playwright", () => ({
  chromium: {
    launch: async () => ({
      close: browser.close,
      newPage: async () => ({ evaluate: browser.googleEvaluate, close: async () => {} }),
      newContext: async () => ({
        close: browser.contextClose,
        newPage: async () => ({ evaluate: browser.evaluate }),
      }),
    }),
  },
}));

vi.mock("../../extensions/google/realtime-voice-provider.ts", () => ({
  buildGoogleRealtimeVoiceProvider: () => ({
    createBrowserSession: async () => ({
      transport: "provider-websocket",
      protocol: "google-live-bidi",
      clientSecret: "synthetic-google-session",
      websocketUrl: "wss://google.example.test/live",
      initialMessage: { setup: {} },
    }),
  }),
}));

vi.mock("vite", () => ({
  createServer: async () => {
    throw new Error("Synthetic relay smoke unavailable");
  },
}));

vi.mock("../../extensions/openai/realtime-voice-provider.ts", () => ({
  buildOpenAIRealtimeVoiceProvider: () => ({
    createBridge: (options: RealtimeVoiceBridgeCreateRequest) => {
      const onFirstAudio = backend.onFirstAudio;
      let responded = false;
      return {
        connect: async () => {},
        isConnected: () => true,
        close: () => {},
        sendAudio: () => {
          if (responded) {
            return;
          }
          responded = true;
          onFirstAudio();
          options.onAudio(Buffer.alloc(1024));
          options.onTranscript?.("user", "glacier", true);
          options.onTranscript?.("assistant", "glacier", true);
          options.onEvent?.({ direction: "server", type: "response.done" });
        },
      };
    },
  }),
}));

vi.mock("../../extensions/openai/speech-provider.ts", () => ({
  buildOpenAISpeechProvider: () => ({
    synthesizeTelephony: async () => ({
      audioBuffer: Buffer.alloc(2),
      outputFormat: "pcm",
      sampleRate: 24_000,
    }),
  }),
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  process.argv = [process.execPath, path.resolve("scripts/dev/realtime-talk-live-smoke.ts")];
  process.exitCode = 0;
});

async function runSmoke(started: Promise<void>, boundary: string) {
  const command = import("../../scripts/dev/realtime-talk-live-smoke.ts");
  await awaitGateBeforeSettlement(started, command, `Smoke completed before ${boundary}`);
  await vi.runAllTimersAsync();
  await command;
  expect(vi.getTimerCount()).toBe(0);
  expect(browser.close).toHaveBeenCalledOnce();
}

afterEach(() => {
  vi.useRealTimers();
  backend.onFirstAudio = () => {};
  process.argv = originalArgv;
  // oxlint-disable-next-line no-warning-comments -- remove after the upstream Bun exitCode fix ships.
  // TODO(bun): Bun does not currently clear a nonzero process.exitCode when assigned undefined.
  process.exitCode = originalExitCode ?? 0;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reports malformed Google Live frames from the serialized browser callback", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "synthetic-google-key");
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const { promise: callbackStarted, resolve: started } = createDeferred();
  browser.googleEvaluate.mockImplementation((callback, payload) => {
    if (typeof callback === "string") {
      return undefined;
    }
    const result = runInNewContext(`(${callback.toString()})(payload)`, {
      payload,
      URL,
      __name: (value: unknown) => value,
      window: { setTimeout, clearTimeout },
      WebSocket: class {
        addEventListener(event: string, listener: (message: { data: string }) => void) {
          if (event === "message") {
            queueMicrotask(() => listener({ data: "not-json" }));
          }
        }
        close() {}
      },
    });
    started();
    return result;
  });
  await runSmoke(callbackStarted, "the Google browser callback");
  expect(output).toHaveBeenCalledWith("google-live-browser-ws: failed", {
    error: process.versions.bun
      ? 'SyntaxError: JSON Parse error: Unexpected identifier "not"'
      : "SyntaxError: Unexpected token 'o', \"not-json\" is not valid JSON",
  });
  expect(process.exitCode).toBe(1);
});

it.each<[string, string, number, boolean, boolean]>([
  ["failed browser media", "failed", 0.2, true, false],
  ["audio too brief to establish speech", "connected", 0.02, true, false],
  ["unrelated browser audio", "connected", 0.2, false, false],
  ["completed browser speech", "connected", 0.2, true, true],
])(
  "reports %s through the smoke command",
  async (_name, connectionState, speechSeconds, transcriptMarker, ok) => {
    browser.evaluate.mockResolvedValue({
      answerHasAudio: true,
      remoteDescriptionApplied: true,
      connectionState,
      transcriptMarker,
      responseDone: true,
      outputAudioBytes: 1024,
      outputAudioSpeechDuration: speechSeconds,
    });
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENCLAW_REALTIME_OPENAI_MODEL", "gpt-realtime-2.1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ value: "test-client-secret" })),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv.push("--openai-only");

    const firstAudio = createDeferred();
    backend.onFirstAudio = () => firstAudio.resolve();
    // Let imports reach streaming before advancing the pacing and close-observation timers.
    await runSmoke(firstAudio.promise, "sending backend audio");
    expect(output).toHaveBeenCalledWith(
      `openai-webrtc-browser: ${ok ? "ok" : "failed"}`,
      expect.objectContaining({ protocol: "ga-realtime" }),
    );
    expect(process.exitCode).toBe(ok ? 0 : 1);
    expect(browser.contextClose).toHaveBeenCalledOnce();
  },
);
