import { afterEach, beforeEach, expect, vi } from "vitest";
import * as gatewayRelayTransport from "./gateway-relay.ts";
import * as googleLiveTransport from "./google-live.ts";
import { useRealtimeTalkMicrophoneFixture } from "./input.test-support.ts";
import type {
  RealtimeTalkCallbacks,
  RealtimeTalkTransport,
  RealtimeTalkTransportContext,
} from "./shared.ts";
import * as webRtcTransport from "./webrtc.ts";

const googleStart = vi.fn(async () => "ready" as const);
export const googleStop = vi.fn();
export const relayStart = vi.fn(async () => "ready" as const);
const relayStop = vi.fn();
export const webRtcStart = vi.fn(async (): Promise<"ready" | "cancelled"> => "ready");
export const relayActivate = vi.fn();
export const webRtcStop = vi.fn();
const googleSetVideoEnabled = vi.fn(async () => undefined);
export const webRtcSetVideoEnabled = vi.fn(async () => undefined);
const googleSwitchCamera = vi.fn(async () => undefined);
export const webRtcSwitchCamera = vi.fn(async () => undefined);

import { RealtimeTalkSession } from "./session.ts";

type MockTransport = RealtimeTalkTransport & {
  ctx: RealtimeTalkTransportContext;
  stop: ReturnType<typeof vi.fn>;
};

export const googleInstances: MockTransport[] = [];
export const relayInstances: MockTransport[] = [];
export const webRtcInstances: MockTransport[] = [];
export const requestTimeoutOptions = { timeoutMs: 30_000 };
export const clientParams = {
  sessionKey: "main",
  capabilities: ["voice-transcript", "voice-selection"],
};
export const cameraParams = {
  ...clientParams,
  capabilities: [...clientParams.capabilities, "camera-frame"],
};
export const relayParams = {
  sessionKey: "main",
  transport: "gateway-relay",
  mode: "realtime",
  brain: "agent-consult",
  capabilities: ["voice-selection"],
};

export function createWebRtcSession(voiceSessionId = "voice-1", clientSecret = "secret") {
  return { provider: "openai", transport: "webrtc" as const, voiceSessionId, clientSecret };
}

export function createRelaySession(provider = "example", relaySessionId = "relay-1") {
  return {
    provider,
    transport: "gateway-relay",
    relaySessionId,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 24000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    },
  };
}

export function videoCatalog(supportsVideoFrames = true) {
  return {
    realtime: {
      activeProvider: "openai",
      providers: [{ id: "openai", label: "OpenAI", supportsVideoFrames }],
    },
  };
}

export function videoRequest(voiceSessionId = "voice-1") {
  return vi.fn(async (method: string) =>
    method === "talk.catalog" ? videoCatalog(true) : createWebRtcSession(voiceSessionId),
  );
}
export function sessionFor(
  request: unknown,
  callbacks: ConstructorParameters<typeof RealtimeTalkSession>[2] = {},
  options: ConstructorParameters<typeof RealtimeTalkSession>[3] = {},
  local: ConstructorParameters<typeof RealtimeTalkSession>[4] = {},
) {
  return new RealtimeTalkSession({ request } as never, "main", callbacks, options, local);
}
export function called(request: { mock: { calls: [string, ...unknown[]][] } }, method: string) {
  return request.mock.calls.some(([name]) => name === method);
}
export function expectRequest(
  request: ReturnType<typeof vi.fn>,
  method: string,
  params: object,
  nth?: number,
) {
  const assertion = expect(request);
  if (nth !== undefined) {
    assertion.toHaveBeenNthCalledWith(nth, method, params, requestTimeoutOptions);
  } else {
    assertion.toHaveBeenCalledWith(method, params, requestTimeoutOptions);
  }
}

export function transportContext(transport: object | undefined): RealtimeTalkTransportContext {
  if (!transport) {
    throw new Error("Expected realtime transport instance");
  }
  return (transport as { ctx: RealtimeTalkTransportContext }).ctx;
}
export function publish(
  context: RealtimeTalkTransportContext,
  text: string,
  role: "user" | "assistant" = "user",
) {
  context.callbacks.onTranscript?.({ role, text, final: true });
}

useRealtimeTalkMicrophoneFixture();

beforeEach(() => {
  googleStart.mockClear();
  googleStop.mockClear();
  relayStart.mockClear();
  relayStop.mockClear();
  webRtcStart.mockClear();
  webRtcStop.mockClear();
  relayActivate.mockClear();
  googleSetVideoEnabled.mockClear();
  webRtcSetVideoEnabled.mockClear();
  googleSwitchCamera.mockClear();
  webRtcSwitchCamera.mockClear();
  googleInstances.length = 0;
  relayInstances.length = 0;
  webRtcInstances.length = 0;
  vi.spyOn(googleLiveTransport, "GoogleLiveRealtimeTalkTransport").mockImplementation(
    function (_session, ctx) {
      const transport: MockTransport = {
        ctx,
        start: googleStart,
        stop: googleStop,
        setVideoEnabled: googleSetVideoEnabled,
        switchCamera: googleSwitchCamera,
      };
      googleInstances.push(transport);
      return transport as unknown as googleLiveTransport.GoogleLiveRealtimeTalkTransport;
    },
  );
  vi.spyOn(gatewayRelayTransport, "GatewayRelayRealtimeTalkTransport").mockImplementation(
    function (_session, ctx) {
      const transport: MockTransport = {
        ctx,
        start: relayStart,
        activate: relayActivate,
        stop: vi.fn((options?: Parameters<RealtimeTalkTransport["stop"]>[0]) => relayStop(options)),
      };
      relayInstances.push(transport);
      return transport as unknown as gatewayRelayTransport.GatewayRelayRealtimeTalkTransport;
    },
  );
  vi.spyOn(webRtcTransport, "WebRtcSdpRealtimeTalkTransport").mockImplementation(
    function (_session, ctx) {
      const transport: MockTransport = {
        ctx,
        start: webRtcStart,
        stop: vi.fn((options?: Parameters<RealtimeTalkTransport["stop"]>[0]) =>
          webRtcStop(options),
        ),
        setVideoEnabled: webRtcSetVideoEnabled,
        switchCamera: webRtcSwitchCamera,
      };
      webRtcInstances.push(transport);
      return transport as unknown as webRtcTransport.WebRtcSdpRealtimeTalkTransport;
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type RequestParams = { voiceSessionId?: string; entryId?: string; text?: string };
type RequestOptions = { signal?: AbortSignal; timeoutMs?: number };
export function strictRequest(handlers: Record<string, () => unknown>) {
  return vi.fn(async (method: string) => {
    const handle = handlers[method];
    if (!handle) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return handle();
  });
}
export function voiceRequest(
  create: () => unknown,
  transcriptEntryIds?: string[],
  handle?: (method: string, params?: RequestParams, options?: RequestOptions) => unknown,
) {
  return vi.fn(async (method: string, params?: RequestParams, options?: RequestOptions) => {
    if (method === "talk.client.create") {
      return create();
    }
    if (method === "talk.client.transcript") {
      transcriptEntryIds?.push(String(params?.entryId));
    }
    if (handle) {
      await handle(method, params, options);
    }
    return { ok: true };
  });
}
export function voiceSession(request: unknown, callbacks: RealtimeTalkCallbacks = {}) {
  return new RealtimeTalkSession({ request } as never, "agent:main:main", callbacks);
}
export function calls<T extends [string, ...unknown[]]>(
  request: { mock: { calls: T[] } },
  method: string,
) {
  return request.mock.calls.filter(([name]) => name === method);
}
export function closeIds(request: { mock: { calls: [string, RequestParams?][] } }) {
  return calls(request, "talk.client.close").map(([, params]) => params?.voiceSessionId);
}

export async function start(request: unknown, callbacks: RealtimeTalkCallbacks) {
  const session = voiceSession(request, callbacks);
  await session.start();
  const context = webRtcInstances.at(-1)?.ctx;
  const handleTranscript = context?.callbacks.onTranscript;
  if (!context || !handleTranscript) {
    throw new Error("expected realtime transcript callback");
  }
  return { session, context, handleTranscript };
}
export function queueRequest(
  voiceSessionId: string,
  handle: (method: string, params?: RequestParams, options?: RequestOptions) => Promise<void>,
) {
  return voiceRequest(() => createWebRtcSession(voiceSessionId), undefined, handle);
}
