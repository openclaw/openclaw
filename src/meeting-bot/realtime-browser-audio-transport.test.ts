import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOwnedTestInstance } from "../plugins/plugin-instance.test-support.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { MeetingBrowserRequestCaller } from "./platform-adapter-contract.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import { createBrowserMeetingRealtimeAudioTransport } from "./realtime-browser-audio-transport.js";

async function setup(
  received = vi.fn(),
  fatal = vi.fn(),
  options: {
    beforeBrowserRequest?: () => void;
    create?: <T>(create: () => Promise<T>) => Promise<T>;
  } = {},
) {
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
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const callBrowser = vi.fn<MeetingBrowserRequestCaller>(async ({ body: requestBody }) => {
    options.beforeBrowserRequest?.();
    const body = requestBody as { fn: string };
    const { action, captureId } = JSON.parse(body.fn) as { action: string; captureId: string };
    if (action === "pull") {
      const pending = createDeferredCore<Record<string, unknown>>();
      pulls.push(pending);
      return { result: JSON.stringify({ captureId, ...(await pending.promise) }) };
    }
    const result = { captureId, isolated: action === "start", closed: action === "stop" };
    return { result: JSON.stringify(result) };
  });
  const create = () =>
    createBrowserMeetingRealtimeAudioTransport({
      nativeTransport,
      hasConfiguredInputCommand: false,
      callBrowser,
      buildCaptureScript: JSON.stringify,
      meetingSessionId: "session-1",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      targetId: "tab-1",
      audioFormat: "pcm16-24khz",
      logger,
    });
  // Production creates and starts the transport inside the join request; keep both there.
  const transport = await (options.create ?? ((run) => run()))(async () => {
    const created = await create();
    created.onFatal(fatal);
    created.startInput(received);
    return created;
  });
  await setImmediate();
  return {
    resolvePull: (result: Record<string, unknown>) => pulls.shift()!.resolve(result),
    pendingPulls: () => pulls.length,
    nativeTransport,
    nativeInput: (audio: Buffer) => startInput.mock.calls.at(-1)?.[0](audio),
    transport,
    received,
    fatal,
    logger,
    lastAction: () => {
      const body = callBrowser.mock.calls.at(-1)?.[0].body as { fn: string };
      return (JSON.parse(body.fn) as { action: string }).action;
    },
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

it("keeps pulling and cleaning up after the joining Gateway request has responded", async () => {
  // Real timers: Node propagates the async context into the 50 ms pull timer, which is how
  // the loop inherits the join request; fake timers would drop it and hide the bug.
  vi.useRealTimers();
  // Models the Gateway request that issued googlemeet.join: its client authority ends once
  // the method responds, and in-process browser requests still dispatched under it are
  // refused (openclaw/openclaw#173896).
  const request = { responded: false };
  const joinScope = {
    isWebchatConnect: () => false,
    signal: new AbortController().signal,
    hasCurrentClientAuthority: () => !request.responded,
  };
  const owner = createOwnedTestInstance("meeting-owner");
  const { transport, received, fatal, resolvePull, pendingPulls, logger, lastAction } = await setup(
    vi.fn(),
    vi.fn(),
    {
      beforeBrowserRequest: () => {
        if (getPluginRuntimeGatewayRequestScope()?.hasCurrentClientAuthority?.() === false) {
          throw new Error("Browser requester is no longer active");
        }
      },
      create: (create) => withPluginRuntimeGatewayRequestScope(joinScope, () => owner.run(create)),
    },
  );
  await vi.waitFor(() => expect(pendingPulls()).toBe(1));
  resolvePull({ isolated: true, base64: Buffer.from([1, 0]).toString("base64") });
  request.responded = true;
  // Without the fix the next pull is refused and the transport goes fatal instead.
  const nextPull = () =>
    vi.waitFor(() => {
      expect(fatal).not.toHaveBeenCalled();
      expect(pendingPulls()).toBe(1);
    });
  await nextPull();
  resolvePull({ isolated: true, base64: Buffer.from([2, 0]).toString("base64") });
  await nextPull();
  expect(received.mock.calls).toEqual([[Buffer.from([1, 0])], [Buffer.from([2, 0])]]);

  const stopping = withPluginRuntimeGatewayRequestScope(joinScope, () => transport.stop());
  resolvePull({ isolated: true });
  await stopping;
  expect(logger.warn).not.toHaveBeenCalled();
  expect(lastAction()).toBe("stop");
});
