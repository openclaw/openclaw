import { vi } from "vitest";

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
