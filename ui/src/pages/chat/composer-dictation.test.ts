// @vitest-environment jsdom
import { createComponent } from "solid-js";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { GatewaySpeechPlayback } from "../../lib/speech-playback.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { renderComposerVoiceButtonSolid } from "./components/chat-composer-controls.tsx";
import { ComposerDictationSession } from "./composer-dictation-session.ts";
import { ComposerDictationOwner, insertComposerDictation } from "./composer-dictation.ts";
import { MockDictationAudioContext, type MockAudioProcessor } from "./talk/input.test-support.ts";

type GatewayListener = (event: GatewayEventFrame) => void;
const listeners = new Set<GatewayListener>();
const controllers: ComposerDictationOwner[] = [];
const processors: MockAudioProcessor[] = [];
const audios: MockAudio[] = [];
let speechStarted = createDeferred();
let request: ReturnType<
  typeof vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>
>;
let getUserMedia: ReturnType<typeof vi.fn<() => Promise<ReturnType<typeof microphone>>>>;

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

const microphone = (stop = vi.fn()) => ({
  getTracks: () => [Object.assign(new EventTarget(), { stop })],
});
class MockAudioContext extends MockDictationAudioContext {
  override createScriptProcessor() {
    const processor = super.createScriptProcessor();
    processors.push(processor);
    return processor;
  }
}

function createClient(): GatewayBrowserClient {
  return {
    addEventListener: vi.fn((listener: GatewayListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    request,
  } as unknown as GatewayBrowserClient;
}

function emit(payload: Record<string, unknown>): void {
  for (const listener of listeners) {
    listener({
      event: "talk.event",
      payload: { transcriptionSessionId: "dictation-1", ...payload },
    } as GatewayEventFrame);
  }
}

function transcript(text: string, transcriptionSessionId = "dictation-1") {
  emit({ transcriptionSessionId, type: "transcript", text, final: true });
}

function sessionResult(sessionId = "dictation-1") {
  return {
    sessionId,
    transcriptionSessionId: sessionId,
    audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
  };
}

function recordRequests(create = async () => sessionResult()) {
  const order: string[] = [];
  request.mockImplementation(async (method, params) => {
    order.push(method);
    return method === "talk.session.create" ? create() : params;
  });
  return order;
}

function expectAppended(sessionId = "dictation-1") {
  expect(request).toHaveBeenCalledWith("talk.session.appendAudio", {
    sessionId,
    audioBase64: "/4AA",
  });
}

function expectClosed(sessionId = "dictation-1", discard = false) {
  expect(request).toHaveBeenCalledWith(
    "talk.session.close",
    { sessionId, ...(discard ? { discard: true } : {}) },
    { timeoutMs: null },
  );
}

function captureAudio() {
  const processor = processors.at(-1);
  assert.isDefined(processor);
  processor.onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array([0, 1, -1]) },
  });
}

function click(target: HTMLElement) {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function pointer(type: string): Event {
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

type ControllerOptions = ConstructorParameters<typeof ComposerDictationOwner>[0];
function controllerFixture(overrides: Omit<Partial<ControllerOptions>, "client"> = {}) {
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
function pointerTarget(target: HTMLElement) {
  target.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 100 }) as DOMRect;
  target.setPointerCapture = vi.fn();
  target.releasePointerCapture = vi.fn();
  return target;
}
function createHarness(overrides: Omit<Partial<ControllerOptions>, "client"> = {}) {
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
function createButtonHarness() {
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

async function startDirect(controller: ComposerDictationOwner) {
  const start = vi.spyOn(ComposerDictationSession.prototype, "start");
  expect(controller.startDirect()).toBe(true);
  await vi.dynamicImportSettled();
  const started = start.mock.results[0];
  assert.isDefined(started);
  await started.value;
}
async function startHold(target: HTMLElement): Promise<void> {
  target.dispatchEvent(pointer("pointerdown"));
  await vi.advanceTimersByTimeAsync(500);
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("talk.session.create", expect.anything()),
  );
}

async function releaseLatched(target: HTMLElement): Promise<void> {
  document.dispatchEvent(pointer("pointerup"));
  click(target);
  await vi.advanceTimersByTimeAsync(0);
}

async function commitLatched(controller: ComposerDictationOwner, target: HTMLElement) {
  await releaseLatched(target);
  void controller.finishActive();
}

function captureStop() {
  const stop = vi.fn();
  getUserMedia.mockResolvedValue(microphone(stop));
  return stop;
}
function expectCommit(onCommit: ReturnType<typeof vi.fn>, preview: string) {
  if (preview) {
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(preview, true);
  } else {
    expect(onCommit).not.toHaveBeenCalled();
  }
}
function latestAudio() {
  const audio = audios.at(-1);
  assert.isDefined(audio);
  return audio;
}

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

describe("ComposerDictationOwner", () => {
  it.each(["cancel", "restart", "draft switch"])(
    "does not revive a retired lazy capture after %s",
    async (transition) => {
      const start = vi.spyOn(ComposerDictationSession.prototype, "start");
      const { controller, options, onCommit, onError } = createHarness({ draftKey: "first" });
      expect(controller.startDirect()).toBe(true);
      expect(controller.connecting).toBe(true);
      expect(audios).toHaveLength(1);
      expect(getUserMedia).not.toHaveBeenCalled();

      if (transition === "draft switch") {
        controller.update({ ...options, draftKey: "next" });
      } else {
        controller.cancel();
      }
      if (transition === "restart") {
        expect(controller.startDirect()).toBe(true);
      }
      await vi.dynamicImportSettled();

      if (transition === "restart") {
        expect(start).toHaveBeenCalledOnce();
        const started = start.mock.results[0];
        assert.isDefined(started);
        await started.value;
        expect(getUserMedia).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledExactlyOnceWith("talk.session.create", expect.anything());
        expect(controller.active).toBe(true);
      } else {
        expect(start).not.toHaveBeenCalled();
        expect(getUserMedia).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
        expect(controller.locksComposer).toBe(false);
      }
      expect(onCommit).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("retires capture before a retained owner adopts another draft's callbacks", async () => {
    const { controller, options, onCommit } = createHarness({ draftKey: "first" });
    const stopTrack = captureStop();
    await startDirect(controller);
    emit({ type: "partial", text: "Old draft words" });
    const nextCommit = vi.fn();

    controller.update({ ...options, draftKey: "next", onCommit: nextCommit });
    transcript("Old draft final words");

    expect(controller.active).toBe(false);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
    expect(nextCommit).not.toHaveBeenCalled();
    await waitForFast(() => expectClosed("dictation-1", true));
  });

  it.each(["", "Keep the preview"])(
    "preserves %j when final transcription fails",
    async (preview) => {
      const { controller, onCommit, onError } = createHarness();
      const publishedErrors: unknown[] = [];
      const unsubscribe = controller.subscribe(() => {
        publishedErrors.push(onError.mock.lastCall?.[0]);
      });

      await startDirect(controller);
      emit({ type: "partial", text: preview });
      const finished = controller.finishActive();
      transcript("failed result");
      emit({ type: "error", message: "Local transcription failed" });
      expect(onError).toHaveBeenCalledExactlyOnceWith("Local transcription failed", {
        kind: "interrupted",
        preservesText: Boolean(preview),
      });
      await expect(finished).resolves.toBe(Boolean(preview));
      expectCommit(onCommit, preview);
      expect(controller.locksComposer).toBe(false);
      expect(listeners.size).toBe(0);
      expect(publishedErrors).toContain("Local transcription failed");
      unsubscribe();
    },
  );

  it.each([false, true])("Read aloud replaces dictation (finalizing: %s)", async (finalizing) => {
    const stopTrack = captureStop();
    const { controller, onCommit, options } = createHarness();
    const previous = new GatewaySpeechPlayback();
    const next = new GatewaySpeechPlayback();
    const reading = previous.speak(options.client, "First message");
    try {
      await speechStarted.promise;
      const firstAudio = latestAudio();
      await startDirect(controller);
      expect(firstAudio.pause).toHaveBeenCalledTimes(2);
      await reading;
      expect(controller.active).toBe(true);
      const finished = finalizing ? controller.finishActive() : null;
      speechStarted = createDeferred();
      const replacement = next.speak(options.client, "Second message");
      expect(controller.active).toBe(false);
      expect(stopTrack).toHaveBeenCalledOnce();
      await speechStarted.promise;
      await waitForFast(() => expectClosed("dictation-1", true));
      transcript("discard");
      emit({ type: "close", reason: "completed" });
      if (finished) {
        await expect(finished).resolves.toBe(false);
      }
      expect(onCommit).not.toHaveBeenCalled();
      const current = latestAudio();
      expect(current.pause).toHaveBeenCalledOnce();
      current.dispatchEvent(new Event("ended"));
      await replacement;
    } finally {
      previous.stop();
      next.stop();
    }
  });

  it("keeps captured text and releases dictation on microphone loss when error delivery throws", async () => {
    const { controller, onCommit, onError } = createHarness();
    const committed = createDeferred<string>();
    onCommit.mockImplementation((text: string) => committed.resolve(text));
    const track = Object.assign(new EventTarget(), { stop: vi.fn() });
    const addListener = vi.spyOn(track, "addEventListener");
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [track] });

    await startDirect(controller);
    emit({ type: "partial", text: "Keep these words" });
    onError.mockImplementation(() => {
      throw new Error("error display failed");
    });

    const ended = addListener.mock.calls[0]?.[1];
    expect(() => {
      if (typeof ended === "function") {
        ended(new Event("ended"));
      }
    }).toThrow("error display failed");

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Microphone"), {
      kind: "interrupted",
      preservesText: true,
    });
    await expect(committed.promise).resolves.toBe("Keep these words");
    expect(onCommit).toHaveBeenCalledWith("Keep these words", true);
    expect(controller.active).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    expect(processors[0]?.onaudioprocess).toBeNull();
    await waitForFast(() => expectClosed());
  });

  it.each(["Escape", "hidden"])("discards direct dictation on %s", async (action) => {
    const { controller, onCommit } = createHarness();
    const stopTrack = captureStop();

    await startDirect(controller);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(controller.active).toBe(true);
    emit({ type: "partial", text: "discard me" });

    if (action === "Escape") {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } else {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    }

    expect(controller.active).toBe(false);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
    await waitForFast(() => expectClosed("dictation-1", true));
  });

  it("Escape discards startup finalization after capture ends before session creation", async () => {
    const createStarted = createDeferred();
    const releaseCreate = createDeferred();
    const closeStarted = createDeferred();
    const release = createDeferred();
    const implementation = request.getMockImplementation();
    request.mockImplementation(async (method, params) => {
      if (method === "talk.session.create") {
        createStarted.resolve();
        await releaseCreate.promise;
      }
      if (method === "talk.session.close" && !params.discard) {
        closeStarted.resolve();
        await release.promise;
      }
      return implementation?.(method, params);
    });
    const h = createHarness();
    expect(h.controller.startDirect()).toBe(true);
    await createStarted.promise;
    captureAudio();
    const finishing = h.controller.finishActive();
    releaseCreate.resolve();
    await closeStarted.promise;
    expectAppended();
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
      expectClosed("dictation-1", true);
      transcript("discarded words");
      emit({ type: "close", reason: "completed" });
      await expect(finishing).resolves.toBe(false);
      expect(h.onCommit).not.toHaveBeenCalled();
    } finally {
      releaseCreate.resolve();
      release.resolve();
      h.controller.dispose();
    }
  });

  it.each(["new capture", "draft switch", "session switch", "client switch"])(
    "unlocks immediately and rejects a pending result after %s",
    async (transition) => {
      const { promise: close, resolve: resolveClose } = createDeferred();
      let sessionsCreated = 0;
      request = vi.fn(async (method: string) => {
        if (method === "talk.session.create") {
          const sessionId = `dictation-${++sessionsCreated}`;
          return sessionResult(sessionId);
        }
        if (method === "talk.session.close") {
          return close;
        }
        return { ok: true };
      });
      const { controller, onCommit, onError, target, options } = createHarness({
        draftKey: "first",
        sessionKey: "first",
      });
      await startHold(target);
      emit({ type: "partial", text: "Old draft preview" });

      const committed = controller.finishActive();

      expect(controller).toMatchObject({ active: false, locksComposer: false });
      expect(onCommit).not.toHaveBeenCalled();
      await waitForFast(() => expectClosed());
      try {
        if (transition === "draft switch") {
          controller.update({ ...options, draftKey: "replacement" });
        } else if (transition === "session switch") {
          controller.update({ ...options, sessionKey: "replacement" });
        } else if (transition === "client switch") {
          controller.update({ ...options, client: createClient() });
        }
        if (transition !== "new capture") {
          controller.update(options);
        } else {
          expect(controller.startDirect()).toBe(true);
          await waitForFast(() => expect(sessionsCreated).toBe(2));
          emit({ transcriptionSessionId: "dictation-2", type: "partial", text: "new preview" });
        }
        const currentPreview = transition === "new capture" ? "new preview" : "";
        expect(controller.transcript).toBe(currentPreview);
        emit({ type: "partial", text: "stale preview" });
        expect(controller.transcript).toBe(currentPreview);
        emit({ type: "error", message: "stale failure" });
        expect(onError).not.toHaveBeenCalled();
        transcript("late final");
        expect(controller.transcript).toBe(currentPreview);
        resolveClose();
        await expect(committed).resolves.toBe(false);
        expect(onCommit).not.toHaveBeenCalled();
      } finally {
        resolveClose();
        controller.dispose();
        await Promise.resolve();
      }
    },
  );

  it("consumes release after the pointer enters the visible hold state", async () => {
    const { controller, onTap, target } = createHarness();

    target.dispatchEvent(pointer("pointerdown"));
    await vi.advanceTimersByTimeAsync(150);
    expect(controller.arming).toBe(true);
    document.dispatchEvent(pointer("pointerup"));
    click(target);

    expect(onTap).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(controller.locksComposer).toBe(false);

    click(target);
    expect(onTap).toHaveBeenCalledOnce();
  });

  it.each([
    [
      new DOMException("blocked", "NotAllowedError"),
      "Microphone access is blocked. Allow it in browser site settings to list inputs.",
    ],
    [
      Object.assign(new Error("Invalid constraint"), {
        name: "OverconstrainedError",
        constraint: "",
      }),
      "The selected microphone is unavailable. Choose another input or System default.",
    ],
  ])("returns to idle without switching microphones after %s", async (error, message) => {
    const settings = loadSettings();
    const device =
      error instanceof DOMException ? settings.realtimeTalkInputDeviceId : "selected-mic";
    patchSettings({ realtimeTalkInputDeviceId: device });
    getUserMedia.mockRejectedValueOnce(error);
    const { controller, onError, target } = createHarness();
    try {
      target.dispatchEvent(pointer("pointerdown"));
      await vi.advanceTimersByTimeAsync(500);
      await waitForFast(() =>
        expect(onError).toHaveBeenCalledWith(message, { kind: "start", preservesText: false }),
      );
      expect(controller).toMatchObject({ active: false, locksComposer: false });
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalledWith("talk.session.create", expect.anything());
      expect(loadSettings().realtimeTalkInputDeviceId).toBe(device);
    } finally {
      controller.dispose();
      patchSettings({ realtimeTalkInputDeviceId: settings.realtimeTalkInputDeviceId });
    }
  });

  it("does not swallow the next click after a hold is cancelled by blur", async () => {
    const { controller, onTap, target } = createHarness();

    target.dispatchEvent(pointer("pointerdown"));
    window.dispatchEvent(new Event("blur"));
    await Promise.resolve();
    click(target);

    expect(onTap).toHaveBeenCalledOnce();
    expect(controller.locksComposer).toBe(false);
  });

  it("streams g711_ulaw audio and drains the final transcript after latched Stop", async () => {
    const order = recordRequests();
    getUserMedia.mockImplementation(async () => {
      order.push("microphone");
      return microphone();
    });
    const { controller, onCommit, target } = createHarness({
      sessionKey: "agent:researcher:conversation",
    });

    await startHold(target);
    expect(request).toHaveBeenCalledWith("talk.session.create", {
      sessionKey: "agent:researcher:conversation",
      mode: "transcription",
      transport: "gateway-relay",
      brain: "none",
    });
    expect(order.slice(0, 2)).toEqual(["microphone", "talk.session.create"]);
    captureAudio();
    await waitForFast(() => expectAppended());
    emit({ type: "partial", text: "hello wor" });
    expect(controller.transcript).toBe("hello wor");
    transcript("hello world");
    emit({ type: "partial", text: "next wor" });
    await releaseLatched(target);
    const finished = controller.finishActive();
    expect(controller).toMatchObject({ finalizing: false, locksComposer: false });
    expect(onCommit).not.toHaveBeenCalled();
    transcript("next words");
    emit({ type: "close", reason: "completed" });
    await expect(finished).resolves.toBe(true);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("hello world next words", true);
    await waitForFast(() => expectClosed());
    expect(order.indexOf("talk.session.appendAudio")).toBeLessThan(
      order.indexOf("talk.session.close"),
    );
  });

  it.each([
    ["", "timeout"],
    ["Keep the preview", "timeout"],
    ["Keep the preview", "disconnect"],
  ])("preserves %j when the final drain ends through %s", async (preview, outcome) => {
    const { controller, options, onCommit } = createHarness();
    await startDirect(controller);
    emit({ type: "partial", text: preview });
    const finished = controller.finishActive();
    await vi.advanceTimersByTimeAsync(0);
    if (outcome === "disconnect") {
      controller.update({ ...options, connected: false });
    } else {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await expect(finished).resolves.toBe(Boolean(preview));
    expectCommit(onCommit, preview);
  });

  it("buffers microphone audio while the transcription session is being created", async () => {
    const { promise: createResult, resolve: resolveCreate } =
      createDeferred<ReturnType<typeof sessionResult>>();
    const order = recordRequests(() => createResult);
    const { controller, onCommit, onError, target } = createHarness();
    await startHold(target);
    captureAudio();
    expect(request).not.toHaveBeenCalledWith("talk.session.appendAudio", expect.anything());

    await commitLatched(controller, target);
    resolveCreate(sessionResult("late-session"));

    await waitForFast(() => expectAppended("late-session"));
    await waitForFast(() => expectClosed("late-session"));
    expect(order.indexOf("talk.session.appendAudio")).toBeLessThan(
      order.indexOf("talk.session.close"),
    );
    expect(onCommit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("closes late session creation after the bounded Stop wait", async () => {
    const created = createDeferred<ReturnType<typeof sessionResult>>();
    request = vi.fn(async (method: string) =>
      method === "talk.session.create" ? created.promise : { ok: true },
    );
    const { controller, target } = createHarness();
    await startHold(target);
    const finished = controller.finishActive();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(finished).resolves.toBe(false);
    expect(controller.locksComposer).toBe(false);
    expect(request).not.toHaveBeenCalledWith("talk.session.close", expect.anything());
    created.resolve(sessionResult("late-session"));
    await waitForFast(() => expectClosed("late-session"));
  });

  it("commits final text promptly when the Gateway disconnects during a partial drain", async () => {
    const harness = createHarness();
    await startHold(harness.target);
    transcript("keep this");
    emit({ type: "partial", text: "unfinished" });

    const disconnectedAt = Date.now();
    harness.controller.update({ ...harness.options, connected: false });
    await waitForFast(() => expectClosed());
    await waitForFast(() =>
      expect(harness.onCommit).toHaveBeenCalledWith("keep this unfinished", true),
    );
    expect(Date.now() - disconnectedAt).toBeLessThan(1000);
    expect(harness.onError).toHaveBeenCalledWith(
      "Dictation stopped because the Gateway disconnected.",
      { kind: "interrupted", preservesText: true },
    );
    expect(harness.onError).toHaveBeenCalledTimes(1);
    expect(harness.controller).toMatchObject({ finalizing: false, locksComposer: false });
    expectClosed();
  });

  it("disables hold while Talk owns the microphone and when the setting is off", async () => {
    const talk = createHarness({ realtimeTalkActive: true });
    talk.target.dispatchEvent(pointer("pointerdown"));
    await vi.advanceTimersByTimeAsync(300);
    expect(request).not.toHaveBeenCalled();
    expect(talk.onTap).not.toHaveBeenCalled();
    talk.controller.dispose();

    const settingOff = createHarness({ enabled: false });
    settingOff.target.dispatchEvent(pointer("pointerdown"));
    settingOff.target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    expect(settingOff.onTap).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("composer microphone button", () => {
  it("keeps a latched hold recording after its release click until a separate tap", async () => {
    const { controller, onCommit, onTap, target } = createButtonHarness();
    await startHold(target);
    transcript("keep recording");

    await releaseLatched(target);
    expect(controller.active).toBe(true);
    expect(request).not.toHaveBeenCalledWith("talk.session.close", expect.anything());
    expect(onCommit).not.toHaveBeenCalled();

    click(target);
    await waitForFast(() => expectClosed());
    emit({ type: "close", reason: "completed" });
    await vi.advanceTimersByTimeAsync(0);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("keep recording", true);
    expect(controller.active).toBe(false);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("keeps a quick tap as the tap action", async () => {
    const { controller, onTap, target } = createButtonHarness();

    target.dispatchEvent(pointer("pointerdown"));
    document.dispatchEvent(pointer("pointerup"));
    click(target);
    await vi.advanceTimersByTimeAsync(300);

    expect(onTap).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(controller.locksComposer).toBe(false);
  });
});

it("insertComposerDictation spaces inserted and replaced selections", () => {
  expect(insertComposerDictation("hello world", "brave new", 6, 6)).toEqual({
    value: "hello brave new world",
    caret: 16,
  });
  expect(insertComposerDictation("hello world", "there", 6, 11)).toEqual({
    value: "hello there",
    caret: 11,
  });
});
