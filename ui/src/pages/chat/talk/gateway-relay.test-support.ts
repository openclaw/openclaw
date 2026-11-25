import { afterEach, beforeEach, expect, vi } from "vitest";
import { GatewayPendingRequests } from "../../../../../packages/gateway-client/src/pending-request.js";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import { consultRunResult } from "./consult.test-support.ts";
import { GatewayRelayRealtimeTalkTransport } from "./gateway-relay.ts";
import {
  createPcmAudioContext,
  prepareRealtimeTalkTestInput,
  type MockAudioBufferSource,
  type MockAudioProcessor,
  type MockAudioSink,
} from "./input.test-support.ts";
import { createGatewayRelaySession } from "./session.test-support.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  type RealtimeTalkTransportContext,
} from "./shared.ts";

type GatewayFrame = { event: string; payload?: unknown };
export function expectClose(
  client: ReturnType<typeof createClient>,
  disposition: "abort" | "detach",
) {
  expect(requestCallsFor(client, "talk.session.close")).toEqual([
    ["talk.session.close", { sessionId: "relay-1", disposition }, { timeoutMs: 8_000 }],
  ]);
}
export function relayEvent(payload: Record<string, unknown>) {
  emitTalkEvent({ relaySessionId: "relay-1", ...payload });
}
export function emitAudio(audioBase64 = "AAAA") {
  relayEvent({ type: "audio", audioBase64 });
}
export function pumpSpeech() {
  const samples = new Float32Array(4096).fill(0.25);
  for (let frame = 0; frame < 3; frame += 1) {
    pumpMicrophone(samples);
  }
}
export function emitFinal(text: string) {
  emitGatewayFrame({
    event: "chat",
    payload: { runId: "run-1", state: "final", message: { text } },
  });
}
type GatewayListener = (event: GatewayFrame) => void;
export const listeners = new Set<GatewayListener>();
export const processors: MockAudioProcessor[] = [];
export const inputSinks: MockAudioSink[] = [];
export const createdSources: MockAudioBufferSource[] = [];
export let getUserMedia: ReturnType<typeof vi.fn>;
export const audioClock = { currentTime: 0 };

export class MockAudioContext extends createPcmAudioContext(
  processors,
  inputSinks,
  createdSources,
) {
  get currentTime(): number {
    return audioClock.currentTime;
  }
}

export function defaultRelayResponse(method: string, supportsBargeIn?: boolean) {
  return method === "talk.catalog"
    ? { realtime: { providers: [{ id: "openai", supportsBargeIn }] } }
    : {};
}

export function createClient(
  supportsBargeIn?: boolean,
  requestImplementation: (method: string) => Promise<unknown> = async (method) =>
    defaultRelayResponse(method, supportsBargeIn),
): RealtimeTalkTransportContext["client"] {
  return {
    hello: {},
    addEventListener: vi.fn((listener: GatewayListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    request: vi.fn(requestImplementation),
  } as unknown as RealtimeTalkTransportContext["client"];
}

export function createConsultClient() {
  const client = createClient();
  vi.mocked(client["request"]).mockImplementation(async (method) => {
    if (method === "talk.client.toolCall") {
      return consultRunResult();
    }
    return defaultRelayResponse(method);
  });
  return client;
}

export function createAudioAppendClient(client = createClient()) {
  const sent: Array<{ id: string }> = [];
  const pending = new GatewayPendingRequests({ createRequestId: () => "audio", nowMs: Date.now });
  const request = vi.mocked(client["request"]).getMockImplementation()!;
  vi.mocked(client["request"]).mockImplementation((method, params, options) =>
    method === "talk.session.appendAudio"
      ? pending.request({ send: (frame) => sent.push(JSON.parse(frame)) }, method, params, options)
      : request(method, params, options),
  );
  return {
    client,
    respond: (index: number) => {
      pending.handleResponse({ type: "res", id: sent[index]!.id, ok: true, payload: {} });
    },
  };
}

export async function createTransport(
  overrides: Partial<RealtimeTalkTransportContext> = {},
  session = createGatewayRelaySession(),
) {
  return new GatewayRelayRealtimeTalkTransport(session, {
    input: await prepareRealtimeTalkTestInput(),
    callbacks: {},
    client: overrides.client ?? createClient(),
    sessionKey: "main",
    ...overrides,
  });
}

export async function startTransport(transport: GatewayRelayRealtimeTalkTransport): Promise<void> {
  await expect(transport.start()).resolves.toBe("ready");
  transport.activate();
}

export function emitGatewayFrame(frame: GatewayFrame): void {
  for (const listener of listeners) {
    listener(frame);
  }
}

export function emitTalkEvent(payload: unknown): void {
  let eventPayload = payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const event = payload as Record<string, unknown>;
    if ((event.type === "audio" || event.type === "clear") && event.talkEvent === undefined) {
      eventPayload = { ...event, talkEvent: { turnId: "turn-1" } };
    }
  }
  emitGatewayFrame({ event: "talk.event", payload: eventPayload });
}

export function emitConsultAndWait(client: RealtimeTalkTransportContext["client"]) {
  emitTalkEvent({
    relaySessionId: "relay-1",
    type: "toolCall",
    callId: "call-1",
    name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    args: { question: "status?" },
  });
  return waitForFast(() => expect(requestCallsFor(client, "talk.client.toolCall")).toHaveLength(1));
}

export function pumpMicrophone(samples: Float32Array): void {
  const processor = processors.at(-1);
  if (!processor) {
    throw new Error("Expected microphone script processor to be created");
  }
  processor.onaudioprocess?.({
    inputBuffer: {
      getChannelData: () => samples,
    },
  });
}

export function zeroPcmBase64(sampleRate: number): string {
  return "AAAA".repeat((sampleRate * 2) / 3);
}

export function requestCallsFor(
  client: RealtimeTalkTransportContext["client"],
  method: string,
): Array<Parameters<RealtimeTalkTransportContext["client"]["request"]>> {
  return vi.mocked(client["request"]).mock.calls.filter((call) => call[0] === method);
}

export function installGatewayRelayTestFixture(): void {
  beforeEach(() => {
    listeners.clear();
    processors.length = 0;
    inputSinks.length = 0;
    createdSources.length = 0;
    audioClock.currentTime = 0;
    vi.stubGlobal("AudioContext", MockAudioContext);
    getUserMedia = vi.fn(async () => ({
      getTracks: () => [Object.assign(new EventTarget(), { stop: vi.fn() })],
    }));
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    listeners.clear();
    processors.length = 0;
    inputSinks.length = 0;
    createdSources.length = 0;
  });
}
