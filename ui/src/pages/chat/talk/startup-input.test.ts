// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import type { RealtimeTalkTransportContext } from "./shared.ts";

type Transport = "webrtc" | "provider-websocket" | "gateway-relay";
type CapturedTransport = { context: RealtimeTalkTransportContext; stop: ReturnType<typeof vi.fn> };
const transports = vi.hoisted(() => [] as CapturedTransport[]);

function mockTransport(_session: unknown, context: RealtimeTalkTransportContext) {
  const stop = vi.fn(() => context.input.stop());
  transports.push({ context, stop });
  return { start: async () => "ready" as const, stop };
}

vi.mock("./webrtc.ts", () => ({ WebRtcSdpRealtimeTalkTransport: vi.fn(mockTransport) }));
vi.mock("./google-live.ts", () => ({ GoogleLiveRealtimeTalkTransport: vi.fn(mockTransport) }));
vi.mock("./gateway-relay.ts", () => ({ GatewayRelayRealtimeTalkTransport: vi.fn(mockTransport) }));

import { RealtimeTalkSession } from "./session.ts";

function microphone() {
  const track = Object.assign(new EventTarget(), { stop: vi.fn() });
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  return { track, stream };
}

function useMicrophone(getUserMedia: MediaDevices["getUserMedia"]) {
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
}

function pendingMicrophone() {
  const media = microphone();
  const permission = createDeferred<MediaStream>();
  const requested = createDeferred();
  const getUserMedia = vi.fn(() => {
    requested.resolve();
    return permission.promise;
  });
  useMicrophone(getUserMedia);
  return { ...media, ...permission, requested, getUserMedia };
}

const sessions: RealtimeTalkSession[] = [];
function sessionFor(request: ReturnType<typeof vi.fn>, transport: Transport = "webrtc") {
  const session = new RealtimeTalkSession(
    { request } as never,
    "agent:main:main",
    {},
    { transport },
    { inputDeviceId: "selected-microphone" },
  );
  sessions.push(session);
  return session;
}

function clientSession(transport: Transport = "webrtc") {
  return { transport, voiceSessionId: "voice-input" };
}

beforeEach(() => {
  transports.length = 0;
});
afterEach(() => {
  for (const session of sessions.splice(0)) {
    void session.stop();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["webrtc", "provider-websocket", "gateway-relay"] as const)(
  "allocates %s only after permission is granted, even after the activation lifetime",
  async (transport) => {
    vi.useFakeTimers();
    const media = pendingMicrophone();
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.create" && transport === "gateway-relay") {
        throw new Error("Use relay session creation");
      }
      return clientSession(transport);
    });
    const session = sessionFor(request, transport);
    const starting = session.start();
    void starting.catch(() => undefined);
    await media.requested.promise;
    await vi.advanceTimersByTimeAsync(65_000);
    expect(request).not.toHaveBeenCalled();
    expect(transports).toHaveLength(0);
    media.resolve(media.stream);
    await starting;
    expect(request.mock.calls.map(([method]) => method)).toEqual(
      transport === "gateway-relay"
        ? ["talk.client.create", "talk.session.create"]
        : ["talk.client.create"],
    );
    expect(media.getUserMedia).toHaveBeenCalledOnce();
    expect(media.getUserMedia).toHaveBeenCalledWith({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
        deviceId: { exact: "selected-microphone" },
      },
    });
    expect(transports[0]?.context.input.stream).toBe(media.stream);
    void session.stop();
    expect(media.track.stop).toHaveBeenCalledOnce();
  },
);

it("cancels pending permission without allocating and releases a late stream", async () => {
  const media = pendingMicrophone();
  const request = vi.fn(async () => clientSession());
  const session = sessionFor(request);
  const starting = session.start();
  void starting.catch(() => undefined);
  await waitForFast(() => expect(media.getUserMedia).toHaveBeenCalledOnce());
  void session.stop();
  await expect(starting).resolves.toBeUndefined();
  media.resolve(media.stream);
  await waitForFast(() => expect(media.track.stop).toHaveBeenCalledOnce());
  expect(request).not.toHaveBeenCalled();
  expect(transports).toHaveLength(0);
});

it("releases prepared microphone ownership when provider creation fails", async () => {
  const media = microphone();
  useMicrophone(vi.fn(async () => media.stream));
  const request = vi.fn().mockRejectedValue(new Error("Provider allocation failed"));
  await expect(sessionFor(request).start()).rejects.toThrow("Provider allocation failed");
  expect(media.track.stop).toHaveBeenCalledOnce();
  expect(transports).toHaveLength(0);
});

it("rejects microphone loss during allocation after retiring the previous call", async () => {
  const previous = microphone();
  const candidate = microphone();
  const allocation = createDeferred<ReturnType<typeof clientSession>>();
  const getUserMedia = vi
    .fn()
    .mockResolvedValueOnce(previous.stream)
    .mockResolvedValueOnce(candidate.stream);
  useMicrophone(getUserMedia);
  let creates = 0;
  const request = vi.fn(async (method: string) => {
    if (method !== "talk.client.create") {
      return { ok: true };
    }
    creates++;
    return creates === 1 ? clientSession() : await allocation.promise;
  });
  const session = sessionFor(request);
  await session.start();
  const starting = session.start();
  void starting.catch(() => undefined);
  await waitForFast(() => expect(creates).toBe(2));
  candidate.track.dispatchEvent(new Event("ended"));
  allocation.resolve({ ...clientSession(), voiceSessionId: "voice-input-candidate" });
  await expect(starting).rejects.toThrow("Microphone");
  expect(candidate.track.stop).toHaveBeenCalledOnce();
  expect(transports).toHaveLength(1);
  expect(previous.track.stop).toHaveBeenCalledOnce();
  expect(transports[0]?.stop).toHaveBeenCalledOnce();
  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "talk.client.close")).toHaveLength(2),
  );
});
