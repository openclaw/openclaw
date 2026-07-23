// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as gatewayRelayTransport from "./realtime-talk-gateway-relay.ts";
import type {
  RealtimeTalkTransport,
  RealtimeTalkTransportContext,
} from "./realtime-talk-shared.ts";
import * as webRtcTransport from "./realtime-talk-webrtc.ts";

const relayStart = vi.fn(async () => undefined);
const relayStop = vi.fn();
const webRtcStart = vi.fn(async () => undefined);
const webRtcStop = vi.fn();

import { RealtimeTalkSession } from "./realtime-talk.ts";

type MockTransport = RealtimeTalkTransport & { ctx: RealtimeTalkTransportContext };

const relayInstances: MockTransport[] = [];
const webRtcInstances: MockTransport[] = [];

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createDeferredTalkClient(options: { gatewayRelayFallback?: boolean } = {}) {
  const creates: Array<ReturnType<typeof createDeferred<unknown>>> = [];
  const request = vi.fn((method: string) => {
    if (method === "talk.client.create") {
      if (options.gatewayRelayFallback) {
        return Promise.reject(new Error("Gateway relay is server-owned"));
      }
      const create = createDeferred<unknown>();
      creates.push(create);
      return create.promise;
    }
    if (method === "talk.session.create") {
      const create = createDeferred<unknown>();
      creates.push(create);
      return create.promise;
    }
    if (method === "talk.session.close" || method === "talk.client.close") {
      return Promise.resolve({ ok: true });
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  return { creates, request };
}

function gatewayRelaySession(relaySessionId: string) {
  return {
    provider: "example",
    transport: "gateway-relay",
    relaySessionId,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 24_000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24_000,
    },
  } as const;
}

function webRtcSession(voiceSessionId: string) {
  return {
    provider: "openai",
    transport: "webrtc",
    voiceSessionId,
    clientSecret: "secret",
  } as const;
}

describe("RealtimeTalkSession lifecycle", () => {
  beforeEach(() => {
    relayStart.mockClear();
    relayStop.mockClear();
    webRtcStart.mockClear();
    webRtcStop.mockClear();
    relayInstances.length = 0;
    webRtcInstances.length = 0;
    vi.spyOn(gatewayRelayTransport, "GatewayRelayRealtimeTalkTransport").mockImplementation(
      function (_session, ctx) {
        const transport: MockTransport = { ctx, start: relayStart, stop: relayStop };
        relayInstances.push(transport);
        return transport as unknown as gatewayRelayTransport.GatewayRelayRealtimeTalkTransport;
      },
    );
    vi.spyOn(webRtcTransport, "WebRtcSdpRealtimeTalkTransport").mockImplementation(
      function (_session, ctx) {
        const transport: MockTransport = { ctx, start: webRtcStart, stop: webRtcStop };
        webRtcInstances.push(transport);
        return transport as unknown as webRtcTransport.WebRtcSdpRealtimeTalkTransport;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes a Gateway relay whose create response arrives after stop", async () => {
    const { creates, request } = createDeferredTalkClient({ gatewayRelayFallback: true });
    const session = new RealtimeTalkSession(
      { request } as never,
      "main",
      {},
      { transport: "gateway-relay" },
    );

    const started = session.start();
    await vi.waitFor(() => expect(creates).toHaveLength(1));
    session.stop();
    creates[0]!.resolve(gatewayRelaySession("relay-stopped"));
    await started;

    expect(request).toHaveBeenCalledWith("talk.session.close", {
      sessionId: "relay-stopped",
    });
    expect(request).toHaveBeenCalledWith("talk.session.create", {
      sessionKey: "main",
      transport: "gateway-relay",
      mode: "realtime",
      brain: "agent-consult",
    });
    expect(relayInstances).toHaveLength(0);
  });

  it("closes a superseded Gateway relay without disturbing its replacement", async () => {
    const { creates, request } = createDeferredTalkClient({ gatewayRelayFallback: true });
    const session = new RealtimeTalkSession(
      { request } as never,
      "main",
      {},
      { transport: "gateway-relay" },
    );

    const firstStart = session.start();
    await vi.waitFor(() => expect(creates).toHaveLength(1));
    session.stop();
    const secondStart = session.start();
    await vi.waitFor(() => expect(creates).toHaveLength(2));
    creates[1]!.resolve(gatewayRelaySession("relay-current"));
    await secondStart;
    creates[0]!.resolve(gatewayRelaySession("relay-stale"));
    await firstStart;

    expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "relay-stale" });
    expect(relayInstances).toHaveLength(1);
    expect(relayStart).toHaveBeenCalledTimes(1);
    expect(webRtcInstances).toHaveLength(0);
    session.stop();
  });

  it("closes a superseded client-owned session without replacing the active call", async () => {
    const { creates, request } = createDeferredTalkClient();
    const session = new RealtimeTalkSession({ request } as never, "main");

    const firstStart = session.start();
    await vi.waitFor(() => expect(creates).toHaveLength(1));
    session.stop();
    const secondStart = session.start();
    await vi.waitFor(() => expect(creates).toHaveLength(2));
    creates[1]!.resolve(webRtcSession("voice-current"));
    await secondStart;
    creates[0]!.resolve(webRtcSession("voice-stale"));
    await firstStart;

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("talk.client.close", {
        sessionKey: "main",
        voiceSessionId: "voice-stale",
      }),
    );
    expect(webRtcInstances).toHaveLength(1);
    expect(webRtcStart).toHaveBeenCalledTimes(1);

    session.stop();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("talk.client.close", {
        sessionKey: "main",
        voiceSessionId: "voice-current",
      }),
    );
  });
});
