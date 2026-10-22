import { onTestFinished, vi } from "vitest";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../../src/talk/describe-view-tool.js";
import { prepareRealtimeTalkTestInput } from "./input.test-support.ts";
import {
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  type RealtimeTalkCallbacks,
  type RealtimeTalkWebRtcSdpSessionResult,
} from "./shared.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./webrtc.ts";

export async function createWebRtcTransport({
  client = {},
  callbacks = {},
  session = {},
  inputDeviceId,
  videoDeviceId,
}: {
  client?: Record<string, unknown>;
  callbacks?: RealtimeTalkCallbacks;
  session?: Partial<RealtimeTalkWebRtcSdpSessionResult>;
  inputDeviceId?: string;
  videoDeviceId?: string;
} = {}) {
  const context = {
    input: await prepareRealtimeTalkTestInput(inputDeviceId),
    client: client as never,
    sessionKey: "main",
    callbacks,
    videoDeviceId,
  };
  const transport = new WebRtcSdpRealtimeTalkTransport(
    { provider: "openai", transport: "webrtc", clientSecret: "client-secret-123", ...session },
    context,
  );
  onTestFinished(() => transport.stop());
  return { transport, context };
}

export async function startWebRtcTransport(
  client: Record<string, unknown> = {},
  callbacks: RealtimeTalkCallbacks = {},
  session: Partial<RealtimeTalkWebRtcSdpSessionResult> = {},
) {
  const onStatus = vi.fn<NonNullable<RealtimeTalkCallbacks["onStatus"]>>();
  const onTalkEvent = vi.fn<NonNullable<RealtimeTalkCallbacks["onTalkEvent"]>>();
  const onTranscript = vi.fn<NonNullable<RealtimeTalkCallbacks["onTranscript"]>>();
  const fixture = await createWebRtcTransport({
    client,
    callbacks: { onStatus, onTalkEvent, onTranscript, ...callbacks },
    session,
  });
  const result = await fixture.transport.start();
  const peer = FakePeerConnection.instances.at(-1);
  if (!peer || result !== "ready") {
    throw new Error("expected ready WebRTC transport");
  }
  return {
    ...fixture,
    peer,
    onStatus,
    onTalkEvent,
    onTranscript,
    dispatch: (event: unknown) => dispatchRealtimeEvent(peer, event),
    sent: (type?: string) =>
      sentRealtimeEvents(peer).filter((event) => !type || event.type === type),
  };
}

export function toolOutput(callId: string, result: unknown) {
  return {
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
  };
}

export function userMessage(content: unknown[]) {
  return { type: "conversation.item.create", item: { type: "message", role: "user", content } };
}

export function stubWebRtc() {
  FakePeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => new Response("answer-sdp")),
  );
  return stubMicrophone();
}

export function expectRequest(method: string, result: unknown) {
  return vi.fn(async (actual: string) => {
    if (actual !== method) {
      throw new Error(`unexpected request: ${actual}`);
    }
    return result;
  });
}

export function audioFixture() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

export function stubMedia(...streams: MediaStream[]) {
  const getUserMedia = vi.fn();
  for (const stream of streams) {
    getUserMedia.mockResolvedValueOnce(stream);
  }
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return getUserMedia;
}

export function stubMicrophone() {
  const { track, stream } = audioFixture();
  const getUserMedia = vi.fn(async () => stream);
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  return { stopInputTrack: track.stop, getUserMedia };
}

export function dispatchCompletedToolCall(
  peer: FakePeerConnection | undefined,
  overrides: {
    responseId?: string | null;
    responseStatus?: string | null;
    itemId?: string | null;
    itemStatus?: string | null;
    callId?: string | null;
    name?: string | null;
    arguments?: string | null;
  } = {},
): void {
  const field = (value: string | null | undefined, fallback: string): string | undefined =>
    value === undefined ? fallback : (value ?? undefined);
  dispatchRealtimeEvent(peer, {
    type: "response.done",
    response: {
      id: field(overrides.responseId, "response-1"),
      status: field(overrides.responseStatus, "completed"),
      output: [
        {
          type: "function_call",
          id: field(overrides.itemId, "item-control"),
          status: field(overrides.itemStatus, "completed"),
          call_id: field(overrides.callId, "call-control"),
          name: field(overrides.name, REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME),
          arguments: field(overrides.arguments, JSON.stringify({ text: "status" })),
        },
      ],
    },
  });
}

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = "closed";
  });
}

export class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];

  connectionState: RTCPeerConnectionState = "new";
  readonly channel = new FakeDataChannel();
  readonly addTrack = vi.fn(() => {
    if (this.connectionState === "closed") {
      throw new DOMException("Cannot add a track to a closed peer", "InvalidStateError");
    }
  });
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;

  constructor() {
    super();
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }

  close(): void {
    this.connectionState = "closed";
  }
}

export function requirePeer(): FakePeerConnection {
  const peer = FakePeerConnection.instances[0];
  if (!peer) {
    throw new Error("expected WebRTC peer");
  }
  return peer;
}

export type SentRealtimeEvent = {
  type?: string;
  item?: { type?: string; [key: string]: unknown };
  [key: string]: unknown;
};

export function dispatchRealtimeEvent(peer: FakePeerConnection | undefined, event: unknown): void {
  peer?.channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
}

export function sentRealtimeEvents(peer: FakePeerConnection | undefined): SentRealtimeEvent[] {
  return peer?.channel.send.mock.calls.map(([payload]) => JSON.parse(String(payload))) ?? [];
}

export class VideoPeerConnection extends FakePeerConnection {
  readonly sctp = { maxMessageSize: 512 };
}

export function cameraFixture(deviceId?: string) {
  const track = Object.assign(new EventTarget(), {
    stop: vi.fn(),
    readyState: "live",
    enabled: true,
    muted: false,
    ...(deviceId ? { getSettings: () => ({ deviceId }) } : {}),
  });
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

export function dispatchDescribeViewToolCall(
  peer: FakePeerConnection | undefined,
  suffix = "camera",
): void {
  dispatchCompletedToolCall(peer, {
    responseId: `response-call-${suffix}`,
    itemId: `item-${suffix}`,
    callId: `call-${suffix}`,
    name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
    arguments: "{}",
  });
}

export async function startCamera(videoDeviceId?: string) {
  const { stream: audio } = audioFixture();
  const camera = cameraFixture(videoDeviceId);
  const getUserMedia = stubMedia(audio, camera.stream);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  const onVideoStream = vi.fn();
  const fixture = await createWebRtcTransport({ callbacks: { onVideoStream }, videoDeviceId });
  await fixture.transport.start();
  await fixture.transport.setVideoEnabled(true);
  return { ...fixture, camera, getUserMedia, onVideoStream };
}

export function stubAnswerSdpFetch() {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response("answer-sdp"));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function pendingAnswer() {
  const pending: { signal?: AbortSignal; response?: Response } = {};
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    pending.signal = init?.signal ?? undefined;
    pending.response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          pending.signal?.addEventListener(
            "abort",
            () => controller.error(pending.signal?.reason),
            { once: true },
          );
        },
      }),
    );
    return pending.response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return Object.assign(pending, { fetchMock });
}

export function dispatchControlToolCall(
  peer: FakePeerConnection | undefined,
  args: { text: string; mode: "status" | "steer" },
): void {
  dispatchCompletedToolCall(peer, {
    name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
    arguments: JSON.stringify(args),
  });
}

export async function createOpenAiTransport(
  client: Record<string, unknown> = {},
  callbacks: RealtimeTalkCallbacks = {},
  session: Partial<RealtimeTalkWebRtcSdpSessionResult> = {},
) {
  return (
    await createWebRtcTransport({
      client,
      callbacks,
      session: { offerResponseMaxBytes: 256 * 1024, ...session },
    })
  ).transport;
}
