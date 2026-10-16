// @vitest-environment jsdom
import { createComponent, createSignal } from "solid-js";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { GatewaySpeechPlayback } from "../../lib/speech-playback.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { renderComposerVoiceButtonSolid } from "./components/chat-composer-controls.tsx";
import { ComposerDictationSession } from "./composer-dictation-session.ts";
import { ComposerDictationController, insertComposerDictation } from "./composer-dictation.ts";

type GatewayListener = (event: GatewayEventFrame) => void;
type MockProcessor = ReturnType<typeof connection> & {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
};

const listeners = new Set<GatewayListener>();
const controllers: ComposerDictationController[] = [];
const processors: MockProcessor[] = [];
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

const connection = () => ({ connect: vi.fn(), disconnect: vi.fn() });
const microphone = (stop = vi.fn()) => ({
  getTracks: () => [Object.assign(new EventTarget(), { stop })],
});
class MockAudioContext {
  readonly destination = {};
  readonly sampleRate = 8000;
  readonly close = vi.fn(async () => undefined);

  createMediaStreamSource = connection;

  createScriptProcessor() {
    const processor: MockProcessor = {
      ...connection(),
      onaudioprocess: null,
    };
    processors.push(processor);
    return processor;
  }

  createGain() {
    return { ...connection(), gain: { value: 1 } };
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      ...connection(),
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0),
    };
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

type ControllerOptions = ConstructorParameters<typeof ComposerDictationController>[0];
function controllerFixture(overrides: Omit<Partial<ControllerOptions>, "client"> = {}) {
  const callbacks = { onCommit: vi.fn(), onError: vi.fn(), onTap: vi.fn() };
  const options = {
    client: createClient(),
    connected: true,
    enabled: true,
    realtimeTalkActive: false,
    onStateChange: vi.fn(),
    ...callbacks,
    ...overrides,
  };
  const controller = new ComposerDictationController(options);
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
  const [revision, setRevision] = createSignal(0);
  const harness = controllerFixture({ onStateChange: renderButton });
  const { controller } = harness;
  function renderButton() {
    setRevision((value) => value + 1);
    flush();
  }
  mountSolid(
    () =>
      createComponent(renderComposerVoiceButtonSolid, {
        connected: true,
        readDictation: () => {
          revision();
          return controller;
        },
        onDictationPointerDown: (event) => controller.handlePointerDown(event),
        onToggleVoice: vi.fn(),
      }),
    { container },
  );
  const target = container.querySelector("button");
  assert.isNotNull(target);
  return { ...harness, target: pointerTarget(target) };
}

async function startDirect(controller: ComposerDictationController) {
  const start = vi.spyOn(ComposerDictationSession.prototype, "start");
  expect(controller.startDirect()).toBe(true);
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

it("binds microphone transcription to the displayed agent session", async () => {
  const { target } = createHarness({ sessionKey: "agent:researcher:conversation" });
  await startHold(target);
  expect(request).toHaveBeenCalledWith("talk.session.create", {
    sessionKey: "agent:researcher:conversation",
    mode: "transcription",
    transport: "gateway-relay",
    brain: "none",
  });
});

async function releaseLatched(target: HTMLElement): Promise<void> {
  document.dispatchEvent(pointer("pointerup"));
  click(target);
  await vi.advanceTimersByTimeAsync(0);
}

async function commitLatched(
  controller: ComposerDictationController,
  target: HTMLElement,
): Promise<void> {
  await releaseLatched(target);
  void controller.finishActive();
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

describe("ComposerDictationController", () => {
  it("surfaces final transcription failure and discards its pending result", async () => {
    const { controller, onCommit, onError } = createHarness();

    await startDirect(controller);
    const finished = controller.finishActive();
    transcript("failed result");
    emit({ type: "error", message: "Local transcription failed" });
    expect(onError).toHaveBeenCalledExactlyOnceWith("Local transcription failed", {
      kind: "interrupted",
      preservesText: false,
    });
    await expect(finished).resolves.toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(controller.locksComposer).toBe(false);
    expect(listeners.size).toBe(0);
  });

  it("lets Read aloud discard pending dictation without stopping newer playback", async () => {
    const { controller, onCommit, options } = createHarness();
    const reading = new GatewaySpeechPlayback();
    try {
      await startDirect(controller);

      const finished = controller.finishActive();
      const speaking = reading.speak(options.client, "New message");
      await speechStarted.promise;
      transcript("confirmed words");
      emit({ type: "close", reason: "completed" });
      await expect(finished).resolves.toBe(false);
      expect(onCommit).not.toHaveBeenCalled();
      const currentAudio = audios.at(-1);
      assert.isDefined(currentAudio);
      expect(currentAudio.pause).toHaveBeenCalledOnce();
      currentAudio.dispatchEvent(new Event("ended"));
      await speaking;
    } finally {
      reading.stop();
    }
  });

  it("stops Read aloud before capture and lets new Read aloud discard dictation", async () => {
    const createStarted = createDeferred();
    const closed = createDeferred();
    const implementation = request.getMockImplementation();
    request.mockImplementation(async (method, params) => {
      if (method === "talk.session.create") {
        createStarted.resolve();
      }
      if (method === "talk.session.close") {
        closed.resolve();
      }
      return implementation?.(method, params);
    });
    const stopTrack = vi.fn();
    getUserMedia.mockResolvedValue(microphone(stopTrack));
    const { controller, onCommit, options } = createHarness();
    const previous = new GatewaySpeechPlayback();
    const next = new GatewaySpeechPlayback();
    const reading = previous.speak(options.client, "First message");
    try {
      await speechStarted.promise;
      const firstAudio = audios[0];
      assert.isDefined(firstAudio);
      expect(controller.startDirect()).toBe(true);
      expect(firstAudio.pause).toHaveBeenCalledTimes(2);
      await reading;
      await createStarted.promise;
      expect(controller.active).toBe(true);

      speechStarted = createDeferred();
      const replacement = next.speak(options.client, "Second message");
      expect(controller.active).toBe(false);
      expect(stopTrack).toHaveBeenCalledOnce();
      await speechStarted.promise;
      await closed.promise;
      expectClosed("dictation-1", true);
      transcript("discard");
      expect(onCommit).not.toHaveBeenCalled();
      const nextAudio = audios.at(-1);
      assert.isDefined(nextAudio);
      nextAudio.dispatchEvent(new Event("ended"));
      await replacement;
    } finally {
      previous.stop();
      next.stop();
    }
  });

  it("keeps captured text and releases dictation on microphone loss when error delivery throws", async () => {
    const { controller, onCommit, onError } = createHarness();
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
    expect(onCommit).toHaveBeenCalledWith("Keep these words");
    expect(controller.active).toBe(false);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    expect(processors[0]?.onaudioprocess).toBeNull();
    await waitForFast(() => expectClosed());
  });

  it.each(["Escape", "hidden"])("discards direct dictation on %s", async (action) => {
    const { controller, onCommit } = createHarness();
    const stopTrack = vi.fn();
    getUserMedia.mockResolvedValue(microphone(stopTrack));

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

  it("unlocks immediately and rejects a pending result after a new session starts", async () => {
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
    const { controller, onCommit, onError, target } = createHarness();
    await startHold(target);

    const committed = controller.finishActive();

    expect(controller).toMatchObject({ active: false, locksComposer: false });
    expect(onCommit).not.toHaveBeenCalled();
    await waitForFast(() => expectClosed());
    try {
      expect(controller.startDirect()).toBe(true);
      await waitForFast(() => expect(sessionsCreated).toBe(2));
      emit({ transcriptionSessionId: "dictation-2", type: "partial", text: "new preview" });
      expect(controller.transcript).toBe("new preview");
      emit({ type: "partial", text: "stale preview" });
      expect(controller.transcript).toBe("new preview");
      emit({ type: "error", message: "stale failure" });
      expect(onError).not.toHaveBeenCalled();
      transcript("late final");
      expect(controller.transcript).toBe("new preview");
      resolveClose();
      await expect(committed).resolves.toBe(false);
      expect(onCommit).not.toHaveBeenCalled();
    } finally {
      resolveClose();
      controller.dispose();
      await Promise.resolve();
    }
  });

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

  it("returns to idle and classifies microphone startup failures", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"));
    const { controller, onError, target } = createHarness();

    target.dispatchEvent(pointer("pointerdown"));
    await vi.advanceTimersByTimeAsync(500);
    await waitForFast(() =>
      expect(onError).toHaveBeenCalledWith(
        "Microphone access is blocked. Allow it in browser site settings to list inputs.",
        { kind: "start", preservesText: false },
      ),
    );

    expect(controller).toMatchObject({ active: false, locksComposer: false });
    expect(request).not.toHaveBeenCalledWith("talk.session.create", expect.anything());
  });

  it("does not switch microphones or allocate dictation after a selected-input constraint failure", async () => {
    const settings = loadSettings();
    patchSettings({ realtimeTalkInputDeviceId: "selected-mic" });
    getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error("Invalid constraint"), {
        name: "OverconstrainedError",
        constraint: "",
      }),
    );
    const { controller, onError, target } = createHarness();
    try {
      target.dispatchEvent(pointer("pointerdown"));
      await vi.advanceTimersByTimeAsync(500);
      expect(onError).toHaveBeenCalledWith(
        "The selected microphone is unavailable. Choose another input or System default.",
        { kind: "start", preservesText: false },
      );
      expect(controller.active).toBe(false);
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalledWith("talk.session.create", expect.anything());
      expect(loadSettings().realtimeTalkInputDeviceId).toBe("selected-mic");
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

  it("streams g711_ulaw audio and commits final transcript from latched Stop", async () => {
    const order = recordRequests();
    getUserMedia.mockImplementation(async () => {
      order.push("microphone");
      return microphone();
    });
    const { controller, onCommit, target } = createHarness();

    await startHold(target);
    expect(order.slice(0, 2)).toEqual(["microphone", "talk.session.create"]);
    captureAudio();
    await waitForFast(() => expectAppended());
    emit({ type: "partial", text: "hello wor" });
    expect(controller.transcript).toBe("hello wor");
    transcript("hello world");
    await releaseLatched(target);
    await expect(controller.finishActive()).resolves.toBe(true);
    expect(controller.finalizing).toBe(false);
    expect(onCommit).toHaveBeenCalledWith("hello world");
    await waitForFast(() => expectClosed());
    expect(order.indexOf("talk.session.appendAudio")).toBeLessThan(
      order.indexOf("talk.session.close"),
    );
  });

  it("reports false for an empty immediate transcript snapshot", async () => {
    const withoutTranscript = createHarness();
    await startHold(withoutTranscript.target);
    const empty = withoutTranscript.controller.finishActive();
    await waitForFast(() => expectClosed());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(empty).resolves.toBe(false);
  });

  it("buffers microphone audio while the transcription session is being created", async () => {
    const { promise: createResult, resolve: resolveCreate } =
      createDeferred<ReturnType<typeof sessionResult>>();
    const order = recordRequests(() => createResult);
    const { controller, onCommit, target } = createHarness();
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
  });

  it.each([false, true])(
    "closes late session creation after Stop (bounded wait: %s)",
    async (bounded) => {
      const created = createDeferred<ReturnType<typeof sessionResult>>();
      request = vi.fn(async (method: string) =>
        method === "talk.session.create" ? created.promise : { ok: true },
      );
      const { controller, onError, target } = createHarness();
      await startHold(target);
      if (bounded) {
        const finished = controller.finishActive();
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(finished).resolves.toBe(false);
        expect(controller.locksComposer).toBe(false);
        expect(request).not.toHaveBeenCalledWith("talk.session.close", expect.anything());
      } else {
        await commitLatched(controller, target);
      }
      created.resolve(sessionResult("late-session"));
      await waitForFast(() => expectClosed("late-session"));
      if (!bounded) {
        expect(onError).not.toHaveBeenCalled();
      }
    },
  );

  it("commits final text promptly when the Gateway disconnects during a partial drain", async () => {
    const harness = createHarness();
    await startHold(harness.target);
    transcript("keep this");
    emit({ type: "partial", text: "unfinished" });

    const disconnectedAt = Date.now();
    harness.controller.update({ ...harness.options, connected: false });
    await waitForFast(() => expectClosed());
    await waitForFast(() => expect(harness.onCommit).toHaveBeenCalledWith("keep this unfinished"));
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
    expect(onCommit).toHaveBeenCalledWith("keep recording");
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
