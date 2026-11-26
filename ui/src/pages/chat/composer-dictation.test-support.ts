import { afterEach, assert, beforeEach, expect, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { ComposerDictationSession } from "./composer-dictation-session.ts";
import { ComposerDictationOwner } from "./composer-dictation.ts";
import { MockDictationAudioContext, type MockAudioProcessor } from "./talk/input.test-support.ts";

type GatewayListener = (event: GatewayEventFrame) => void;
export const listeners = new Set<GatewayListener>();
const controllers: ComposerDictationOwner[] = [];
export const processors: MockAudioProcessor[] = [];
export const audios: MockAudio[] = [];
export let speechStarted = createDeferred();
export let request: ReturnType<
  typeof vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>
>;
export let getUserMedia: ReturnType<typeof vi.fn<() => Promise<ReturnType<typeof microphone>>>>;

class MockAudio extends EventTarget {
  readonly pause = vi.fn();
  readonly load = vi.fn();
  readonly removeAttribute = vi.fn();
  readonly play = vi.fn(async () => {
    if (this.src.startsWith("blob:")) {
      speechStarted.resolve();
    }
  });

  constructor(public src: string) {
    super();
    audios.push(this);
  }
}

export const microphone = (stop = vi.fn()) => ({
  getTracks: () => [Object.assign(new EventTarget(), { stop })],
});
class MockAudioContext extends MockDictationAudioContext {
  override createScriptProcessor() {
    const processor = super.createScriptProcessor();
    processors.push(processor);
    return processor;
  }
}

export function createClient(): GatewayBrowserClient {
  return {
    addEventListener: vi.fn((listener: GatewayListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    request,
  } as unknown as GatewayBrowserClient;
}

export function emit(payload: Record<string, unknown>): void {
  for (const listener of listeners) {
    listener({
      event: "talk.event",
      payload: { transcriptionSessionId: "dictation-1", ...payload },
    } as GatewayEventFrame);
  }
}

export function transcript(text: string, transcriptionSessionId = "dictation-1") {
  emit({ transcriptionSessionId, type: "transcript", text, final: true });
}

export function sessionResult(sessionId = "dictation-1") {
  return {
    sessionId,
    transcriptionSessionId: sessionId,
    audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
  };
}

export function recordRequests(create = async () => sessionResult()) {
  const order: string[] = [];
  request.mockImplementation(async (method, params) => {
    order.push(method);
    return method === "talk.session.create" ? create() : params;
  });
  return order;
}

export type ControllerOptions = ConstructorParameters<typeof ComposerDictationOwner>[0];
export function controllerFixture(overrides: Omit<Partial<ControllerOptions>, "client"> = {}) {
  const callbacks = { onCommit: vi.fn(), onError: vi.fn(), onTap: vi.fn() };
  const options = {
    client: createClient(),
    connected: true,
    enabled: true,
    realtimeTalkActive: false,
    ...callbacks,
    ...overrides,
  };
  const controller = new ComposerDictationOwner(options);
  controllers.push(controller);
  return { controller, options, ...callbacks };
}
export async function startDirect(controller: ComposerDictationOwner) {
  const start = vi.spyOn(ComposerDictationSession.prototype, "start");
  expect(controller.startDirect()).toBe(true);
  await vi.dynamicImportSettled();
  const started = start.mock.results[0];
  assert.isDefined(started);
  await started.value;
}
export function resetSpeechStarted(): void {
  speechStarted = createDeferred();
}

/** External media/Gateway fixtures; the production session and owner stay real. */
export function installDictationSessionFixtures(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    processors.length = 0;
    audios.length = 0;
    speechStarted = createDeferred();
    request = vi.fn(async (method: string) => {
      if (method === "tts.speak") {
        return { audioBase64: "UklGRg==", mimeType: "audio/wav", provider: "openai" };
      }
      if (method === "talk.session.create") {
        return sessionResult();
      }
      return { ok: true };
    });
    getUserMedia = vi.fn(async () => microphone());
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("Audio", MockAudio);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => "blob:synthetic-speech");
        static override revokeObjectURL = vi.fn();
      },
    );
  });

  afterEach(() => {
    for (const controller of controllers.splice(0)) {
      controller.dispose();
    }
    cleanupSolid();
    document.body.replaceChildren();
    listeners.clear();
    processors.length = 0;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}
