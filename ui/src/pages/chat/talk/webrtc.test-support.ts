import { vi } from "vitest";
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
  const { transport } = await createWebRtcTransport({
    client,
    callbacks: { onStatus, onTalkEvent, onTranscript, ...callbacks },
    session,
  });
  const result = await transport.start();
  const peer = FakePeerConnection.instances.at(-1);
  if (!peer || result !== "ready") {
    throw new Error("expected ready WebRTC transport");
  }
  return {
    transport,
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
