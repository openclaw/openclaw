import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import { createBrowserMeetingRealtimeAudioTransport } from "./realtime-browser-audio-transport.js";

async function setup(received = vi.fn(), fatal = vi.fn()) {
  const startInput = vi.fn<MeetingRealtimeAudioTransport["startInput"]>();
  const nativeTransport = {
    onFatal: vi.fn(),
    startInput,
    stop: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    writeOutput: vi.fn(async () => {}),
    clearOutput: vi.fn(async () => {}),
  } satisfies MeetingRealtimeAudioTransport;
  const pulls: ReturnType<typeof createDeferredCore<Record<string, unknown>>>[] = [];
  const transport = await createBrowserMeetingRealtimeAudioTransport({
    nativeTransport,
    hasConfiguredInputCommand: false,
    callBrowser: async ({ body: requestBody }) => {
      const body = requestBody as { fn: string };
      const { action, captureId } = JSON.parse(body.fn) as { action: string; captureId: string };
      if (action === "pull") {
        const pending = createDeferredCore<Record<string, unknown>>();
        pulls.push(pending);
        return { result: JSON.stringify({ captureId, ...(await pending.promise) }) };
      }
      const result = { captureId, isolated: action === "start", closed: action === "stop" };
      return { result: JSON.stringify(result) };
    },
    buildCaptureScript: JSON.stringify,
    meetingSessionId: "session-1",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    targetId: "tab-1",
    audioFormat: "pcm16-24khz",
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  });
  transport.onFatal(fatal);
  transport.startInput(received);
  await setImmediate();
  return {
    resolvePull: (result: Record<string, unknown>) => pulls.shift()!.resolve(result),
    nativeTransport,
    nativeInput: (audio: Buffer) => startInput.mock.calls.at(-1)?.[0](audio),
    transport,
    received,
    fatal,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("feeds remote playback to the provider while native microphone injection stays out", async () => {
  const { transport, received, nativeInput, resolvePull, nativeTransport } = await setup();
  const assistant = Buffer.from([1, 0, 2, 0]);
  const remote = Buffer.from([3, 0, 4, 0]);
  await transport.writeOutput(assistant);
  nativeInput(assistant);
  resolvePull({ isolated: true, base64: remote.toString("base64") });
  await setImmediate();
  expect(received.mock.calls).toEqual([[remote]]);
  expect(nativeTransport.writeOutput).toHaveBeenCalledWith(assistant);
  expect(transport.inputAudioIsolated).toBe(true);
  await transport.stop();
});

it("discards a pull after stop and rejects an expired browser capture", async () => {
  const { transport, received, fatal, resolvePull } = await setup();
  // Retire host input before the serialized page read finishes.
  const stopping = transport.stop();
  resolvePull({ isolated: true, base64: Buffer.from([9, 0]).toString("base64") });
  await stopping;
  expect(received).not.toHaveBeenCalled();
  expect(fatal).not.toHaveBeenCalled();

  const next = await setup(received, fatal);
  next.resolvePull({ closed: true });
  await setImmediate();
  expect(fatal).toHaveBeenCalledOnce();
  expect(received).not.toHaveBeenCalled();
  expect(next.nativeTransport.stop).toHaveBeenCalledOnce();
  await next.transport.stop();
});
