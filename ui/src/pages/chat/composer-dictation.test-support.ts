import { createComponent } from "solid-js";
import { afterEach, assert, beforeEach, expect, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { renderComposerVoiceButtonSolid } from "./components/chat-composer-controls.tsx";
import { ComposerDictationSession } from "./composer-dictation-session.ts";
import { ComposerDictationOwner } from "./composer-dictation.ts";
import type { createDirectDictationTextarea } from "./composer-direct-dictation.ts";
import { MockDictationAudioContext, type MockAudioProcessor } from "./talk/input.test-support.ts";

export const dictationIo = {
  speechStarted: createDeferred(),
  request: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(),
  getUserMedia: vi.fn<() => Promise<ReturnType<typeof microphone>>>(),
};

export type GatewayListener = (event: GatewayEventFrame) => void;
export const listeners = new Set<GatewayListener>();
export const controllers: ComposerDictationOwner[] = [];
export const refinementTextareas: ReturnType<typeof createDirectDictationTextarea>[] = [];
export const processors: MockAudioProcessor[] = [];
export const audios: MockAudio[] = [];

export class MockAudio extends EventTarget {
  readonly pause = vi.fn();
  readonly load = vi.fn();
  readonly removeAttribute = vi.fn();
  readonly play = vi.fn(async () => {
    if (this.src.startsWith("blob:")) {
      dictationIo.speechStarted.resolve();
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
export class MockAudioContext extends MockDictationAudioContext {
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
    request: dictationIo.request,
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
  dictationIo.request.mockImplementation(async (method, params) => {
    order.push(method);
    return method === "talk.session.create" ? create() : params;
  });
  return order;
}

export function expectAppended(sessionId = "dictation-1") {
  expect(dictationIo.request).toHaveBeenCalledWith("talk.session.appendAudio", {
    sessionId,
    audioBase64: "/4AA",
  });
}

export function expectClosed(sessionId = "dictation-1", discard = false) {
  expect(dictationIo.request).toHaveBeenCalledWith(
    "talk.session.close",
    { sessionId, ...(discard ? { discard: true } : {}) },
    { timeoutMs: null },
  );
}

export function captureAudio() {
  const processor = processors.at(-1);
  assert.isDefined(processor);
  processor.onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array([0, 1, -1]) },
  });
}

export function click(target: HTMLElement, detail = 1) {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
}

export function pointer(type: string): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 50,
    clientY: 50,
    button: 0,
  });
  Object.defineProperty(event, "pointerId", { value: 7 });
  return event;
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
export function pointerTarget(target: HTMLElement) {
  target.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 100 }) as DOMRect;
  target.setPointerCapture = vi.fn();
  target.releasePointerCapture = vi.fn();
  return target;
}
export function createHarness(overrides: Omit<Partial<ControllerOptions>, "client"> = {}) {
  const harness = controllerFixture(overrides);
  const target = pointerTarget(document.createElement("button"));
  target.addEventListener("pointerdown", (event) =>
    harness.controller.handlePointerDown(event as PointerEvent),
  );
  target.addEventListener("click", (event) => harness.controller.handleClick(event));
  document.body.append(target);
  return { ...harness, target };
}

// Drives the shipped microphone button, whose click routing differs from the
// controller-only harness above once dictation is active.
export function createButtonHarness() {
  const container = document.createElement("div");
  document.body.append(container);
  const harness = controllerFixture();
  const { controller } = harness;
  mountSolid(
    () => {
      const owner = projectOwner(controller, (value) => value);
      return createComponent(renderComposerVoiceButtonSolid, {
        connected: true,
        readDictation: owner.read,
        onDictationPointerDown: (event) => controller.handlePointerDown(event),
        onToggleVoice: vi.fn(),
      });
    },
    { container },
  );
  const target = container.querySelector("button");
  assert.isNotNull(target);
  return { ...harness, target: pointerTarget(target) };
}

export async function startDirect(controller: ComposerDictationOwner) {
  const start = vi.spyOn(ComposerDictationSession.prototype, "start");
  const index = start.mock.results.length;
  expect(controller.startDirect()).toBe(true);
  await vi.dynamicImportSettled();
  const started = start.mock.results[index];
  assert.isDefined(started);
  await started.value;
}
export async function startHold(target: HTMLElement): Promise<void> {
  target.dispatchEvent(pointer("pointerdown"));
  await vi.advanceTimersByTimeAsync(500);
  await waitForFast(() =>
    expect(dictationIo.request).toHaveBeenCalledWith("talk.session.create", expect.anything()),
  );
}

export async function releaseLatched(target: HTMLElement): Promise<void> {
  document.dispatchEvent(pointer("pointerup"));
  click(target);
  await vi.advanceTimersByTimeAsync(0);
}

export function captureStop() {
  const stop = vi.fn();
  dictationIo.getUserMedia.mockResolvedValue(microphone(stop));
  return stop;
}
export function expectCommit(onCommit: ReturnType<typeof vi.fn>, preview: string) {
  if (preview) {
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(preview, true);
  } else {
    expect(onCommit).not.toHaveBeenCalled();
  }
}
export function latestAudio() {
  const audio = audios.at(-1);
  assert.isDefined(audio);
  return audio;
}

export function setupDictationFixtures() {
  beforeEach(() => {
    vi.useFakeTimers();
    listeners.clear();
    processors.length = 0;
    audios.length = 0;
    dictationIo.speechStarted = createDeferred();
    dictationIo.request = vi.fn(async (method: string) => {
      if (method === "tts.speak") {
        return { audioBase64: "UklGRg==", mimeType: "audio/wav", provider: "openai" };
      }
      if (method === "talk.session.create") {
        return sessionResult();
      }
      return { ok: true };
    });
    dictationIo.getUserMedia = vi.fn(async () => microphone());
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: dictationIo.getUserMedia },
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
    for (const textarea of refinementTextareas.splice(0)) {
      textarea.dispose();
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
