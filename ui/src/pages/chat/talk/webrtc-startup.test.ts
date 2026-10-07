// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import { prepareRealtimeTalkTestInput } from "./input.test-support.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./webrtc.ts";

let stopInputTrack: ReturnType<typeof vi.fn>;

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = "closed";
  });

  constructor(readyState: RTCDataChannelState = "connecting") {
    super();
    this.readyState = readyState;
  }

  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }
}

class FakePeerConnection extends EventTarget {
  static instance: FakePeerConnection | undefined;
  static initialChannelState: RTCDataChannelState = "connecting";

  connectionState: RTCPeerConnectionState = "new";
  readonly channel = new FakeDataChannel(FakePeerConnection.initialChannelState);
  readonly addTrack = vi.fn();
  remoteDescription: RTCSessionDescriptionInit | null = null;

  constructor() {
    super();
    FakePeerConnection.instance = this;
  }

  createDataChannel(): RTCDataChannel {
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "offer-sdp" };
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }

  close(): void {
    this.connectionState = "closed";
  }
}

function requirePeer(): FakePeerConnection {
  const peer = FakePeerConnection.instance;
  if (!peer) {
    throw new Error("expected WebRTC peer");
  }
  return peer;
}

async function createTransport(
  callbacks: Record<string, unknown> = {},
): Promise<WebRtcSdpRealtimeTalkTransport> {
  return new WebRtcSdpRealtimeTalkTransport(
    {
      provider: "openai",
      transport: "webrtc",
      clientSecret: "client-secret-123",
    },
    {
      input: await prepareRealtimeTalkTestInput(),
      client: {} as never,
      sessionKey: "main",
      callbacks: callbacks as never,
    },
  );
}

beforeEach(() => {
  FakePeerConnection.instance = undefined;
  FakePeerConnection.initialChannelState = "connecting";
  stopInputTrack = vi.fn();
  const track = Object.assign(new EventTarget(), {
    stop: stopInputTrack,
  }) as unknown as MediaStreamTrack;
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("WebRTC Talk control-channel startup", () => {
  it("waits for the control data channel before reporting ready", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = await createTransport({ onStatus, onTalkEvent });
    let settled = false;
    const starting = transport.start().then((result) => {
      settled = true;
      return result;
    });
    const peer = requirePeer();
    await waitForFast(() => expect(peer.remoteDescription).not.toBeNull());

    expect(settled).toBe(false);
    expect(onStatus).not.toHaveBeenCalledWith("listening");
    peer.channel.open();

    await expect(starting).resolves.toBe("ready");
    expect(onStatus).toHaveBeenCalledWith("listening");
    expect(onTalkEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "session.ready" }));
    transport.stop();
  });

  it("reports ready when the control data channel is already open", async () => {
    FakePeerConnection.initialChannelState = "open";
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = await createTransport({ onStatus, onTalkEvent });

    await expect(transport.start()).resolves.toBe("ready");
    expect(onStatus).toHaveBeenCalledWith("listening");
    expect(onTalkEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "session.ready" }));
    transport.stop();
  });

  it("times out a channel that never opens and suppresses late open", async () => {
    vi.useFakeTimers();
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = await createTransport({ onStatus, onTalkEvent });
    const failed = transport.start().catch((error: unknown) => error);
    const peer = requirePeer();
    await vi.waitFor(() => expect(peer.remoteDescription).not.toBeNull());

    await vi.advanceTimersByTimeAsync(15_000);
    expect(await failed).toMatchObject({
      message: expect.stringContaining("Realtime control channel did not open within 15000ms"),
    });
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(peer.channel.close).toHaveBeenCalledOnce();
    expect(peer.connectionState).toBe("closed");
    expect(document.querySelector("audio")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    peer.channel.open();
    expect(onStatus).not.toHaveBeenCalledWith("listening");
    expect(onTalkEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.ready" }),
    );
  });

  it("cancels channel startup and releases resources when stopped", async () => {
    const transport = await createTransport();
    const starting = transport.start();
    const peer = requirePeer();
    await waitForFast(() => expect(peer.remoteDescription).not.toBeNull());

    transport.stop({ emitClosed: false });

    await expect(starting).resolves.toBe("cancelled");
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(peer.channel.close).toHaveBeenCalledOnce();
    expect(peer.connectionState).toBe("closed");
    expect(document.querySelector("audio")).toBeNull();
  });

  it("rejects startup when the peer fails before open", async () => {
    const transport = await createTransport();
    const failed = transport.start().catch((error: unknown) => error);
    const peer = requirePeer();
    await waitForFast(() => expect(peer.remoteDescription).not.toBeNull());

    peer.connectionState = "failed";
    peer.dispatchEvent(new Event("connectionstatechange"));

    expect(await failed).toMatchObject({ message: "Realtime connection closed" });
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(peer.channel.close).toHaveBeenCalledOnce();
    expect(document.querySelector("audio")).toBeNull();
  });

  it.each([
    ["error", "failed"],
    ["close", "closed"],
  ] as const)("rejects startup when the control channel %s", async (event, outcome) => {
    const transport = await createTransport();
    const failed = transport.start().catch((error: unknown) => error);
    const peer = requirePeer();
    await waitForFast(() => expect(peer.remoteDescription).not.toBeNull());
    if (event === "close") {
      peer.channel.readyState = "closed";
    }

    peer.channel.dispatchEvent(new Event(event));

    expect(await failed).toMatchObject({ message: `Realtime control channel ${outcome}` });
    expect(stopInputTrack).toHaveBeenCalledOnce();
    expect(peer.channel.close).toHaveBeenCalledOnce();
    expect(document.querySelector("audio")).toBeNull();
  });
});
