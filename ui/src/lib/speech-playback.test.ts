// @vitest-environment jsdom

import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { GatewaySpeechPlayback, resolveSpeechTextLimit } from "./speech-playback.ts";

let started = createDeferred();
const audio: FakeAudio[] = [];
const players: GatewaySpeechPlayback[] = [];
const createUrl = vi.fn(() => "blob:synthetic-speech");
const revokeUrl = vi.fn();

class FakeAudio extends EventTarget {
  play = vi.fn(async () => {
    if (this.src.startsWith("blob:")) {
      started.resolve();
    }
  });
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  constructor(public src: string) {
    super();
    audio.push(this);
  }
}

beforeEach(() => {
  started = createDeferred();
  audio.length = 0;
  createUrl.mockClear();
  revokeUrl.mockClear();
  vi.stubGlobal("Audio", FakeAudio);
  vi.spyOn(URL, "createObjectURL").mockImplementation(createUrl);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeUrl);
});

afterEach(() => {
  for (const playback of players.splice(0)) {
    playback.stop();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function player() {
  const value = new GatewaySpeechPlayback();
  players.push(value);
  return value;
}

const speechResult = { audioBase64: "UklGRg==", mimeType: "audio/wav", provider: "openai" };

it.each(["tts.speak", "talk.speak"] as const)(
  "plays a long answer through sequential bounded %s requests",
  async (method) => {
    const request = createGatewayRequestMock(async () => speechResult);
    const client = createTestGatewayClient(request);
    const playback = player();
    const speaking = playback.speak(client, "a".repeat(5000), method);
    await started.promise;
    expect(request).toHaveBeenCalledExactlyOnceWith(method, { text: "a".repeat(4096) });
    const element = expectDefined(audio[0], "first speech element");
    started = createDeferred();
    element.dispatchEvent(new Event("ended"));
    await started.promise;
    expect(request).toHaveBeenLastCalledWith(method, { text: "a".repeat(904) });
    expect(audio).toHaveLength(1);
    element.dispatchEvent(new Event("ended"));
    await speaking;
    expect(revokeUrl).toHaveBeenCalledTimes(2);
  },
);

it("uses the configured speech bound and stops before another chunk is requested", async () => {
  const request = createGatewayRequestMock(async () => speechResult);
  const playback = player();
  const bound = resolveSpeechTextLimit({ tts: { maxTextLength: 6 } });
  const speaking = playback.speak(
    createTestGatewayClient(request),
    "abcdefghi",
    "tts.speak",
    () => true,
    bound,
  );
  await started.promise;
  expect(request).toHaveBeenCalledExactlyOnceWith("tts.speak", { text: "abcdef" });
  playback.stop();
  await speaking;
  expect(request).toHaveBeenCalledTimes(1);
  expect(revokeUrl).toHaveBeenCalledOnce();
});

it("releases a cancelled pending synthesis without playing its late result", async () => {
  const pending = createDeferred<typeof speechResult>();
  const request = createGatewayRequestMock(() => pending.promise);
  const playback = player();
  const speaking = playback.speak(createTestGatewayClient(request), "Pending speech");
  playback.stop();
  await speaking;
  pending.resolve(speechResult);
  await pending.promise;
  expect(createUrl).not.toHaveBeenCalled();
});

it("lets Talk supersede Read aloud and stops Talk before a new Read aloud plays", async () => {
  const request = createGatewayRequestMock(async () => speechResult);
  const client = createTestGatewayClient(request);
  const reading = player();
  const first = reading.speak(client, "First message");
  await started.promise;
  const firstAudio = expectDefined(audio[0], "first Read aloud audio");
  const talk = player();
  const stopTalk = vi.fn();
  talk.prepare(client, stopTalk);
  expect(firstAudio.pause).toHaveBeenCalledTimes(2);
  await first;
  expect(revokeUrl).toHaveBeenCalledOnce();
  started = createDeferred();
  const second = player().speak(client, "Second message");
  await started.promise;
  expect(stopTalk).toHaveBeenCalledOnce();
  reading.stop();
  expectDefined(audio[2], "second Read aloud audio").dispatchEvent(new Event("ended"));
  await second;
  expect(revokeUrl).toHaveBeenCalledTimes(2);
});
