// @vitest-environment jsdom
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { renderComposerVoiceButton } from "./components/chat-composer-controls.tsx";
import { ComposerDictationController, insertComposerDictation } from "./composer-dictation.ts";

type GatewayListener = (event: GatewayEventFrame) => void;
type MockProcessor = {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
};

const listeners = new Set<GatewayListener>();
const processors: MockProcessor[] = [];
let request: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;

class MockAudioContext {
  readonly destination = {};
  readonly sampleRate = 8000;
  readonly close = vi.fn(async () => undefined);

  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }

  createScriptProcessor() {
    const processor: MockProcessor = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    };
    processors.push(processor);
    return processor;
  }

  createGain() {
    return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } };
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
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
    listener({ event: "talk.event", payload } as GatewayEventFrame);
  }
}

function pointer(type: string, pointerId = 7, x = 50, y = 50): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

function createHarness(
  overrides: {
    enabled?: boolean;
    realtimeTalkActive?: boolean;
    dictationAvailable?: boolean;
  } = {},
) {
  const onCommit = vi.fn();
  const onError = vi.fn();
  const onStateChange = vi.fn();
  const onTap = vi.fn();
  const onDictationUnavailable = vi.fn();
  const options = {
    client: createClient(),
    connected: true,
    enabled: overrides.enabled ?? true,
    dictationAvailable: overrides.dictationAvailable,
    realtimeTalkActive: overrides.realtimeTalkActive ?? false,
    onCommit,
    onError,
    onStateChange,
    onTap,
    onDictationUnavailable,
  };
  const controller = new ComposerDictationController(options);
  const target = document.createElement("button");
  target.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 100 }) as DOMRect;
  target.setPointerCapture = vi.fn();
  target.releasePointerCapture = vi.fn();
  target.addEventListener("pointerdown", (event) =>
    controller.handlePointerDown(event as PointerEvent),
  );
  target.addEventListener("click", (event) => controller.handleClick(event));
  document.body.append(target);
  return {
    controller,
    onCommit,
    onDictationUnavailable,
    onError,
    onStateChange,
    onTap,
    options,
    target,
  };
}

// Drives the shipped microphone button, whose click routing differs from the
// controller-only harness above once dictation is active.
function createButtonHarness() {
  const onCommit = vi.fn();
  const onTap = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const controller = new ComposerDictationController({
    client: createClient(),
    connected: true,
    enabled: true,
    realtimeTalkActive: false,
    onCommit,
    onError: vi.fn(),
    onStateChange: renderButton,
    onTap,
  });
  function renderButton() {
    render(
      renderComposerVoiceButton({
        connected: true,
        readDictation: () => controller,
        onDictationPointerDown: (event) => controller.handlePointerDown(event),
        onToggleVoice: vi.fn(),
      }),
      container,
    );
  }
  renderButton();
  const target = container.querySelector("button");
  if (!target) {
    throw new Error("expected the microphone button");
  }
  target.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 100 }) as DOMRect;
  target.setPointerCapture = vi.fn();
  target.releasePointerCapture = vi.fn();
  return { controller, onCommit, onTap, target };
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
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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
  request = vi.fn(async (method: string) => {
    if (method === "talk.session.create") {
      return {
        sessionId: "dictation-1",
        transcriptionSessionId: "dictation-1",
        audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
      };
    }
    return { ok: true };
  });
  getUserMedia = vi.fn(async () => ({
    getTracks: () => [Object.assign(new EventTarget(), { stop: vi.fn() })],
  }));
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  vi.stubGlobal("AudioContext", MockAudioContext);
});

afterEach(() => {
  document.body.replaceChildren();
  listeners.clear();
  processors.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ComposerDictationController", () => {
  it("keeps captured text and releases dictation on microphone loss when error delivery throws", async () => {
    const { controller, onCommit, onError } = createHarness();
    const track = Object.assign(new EventTarget(), { stop: vi.fn() });
    const addListener = vi.spyOn(track, "addEventListener");
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [track] });
    try {
      expect(controller.startDirect()).toBe(true);
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("talk.session.create", expect.anything()),
      );
      emit({ transcriptionSessionId: "dictation-1", type: "partial", text: "Keep these words" });
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
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
      );
    } finally {
      controller.dispose();
    }
  });

  it.each(["Escape", "hidden"])("cancels direct dictation on %s", async (action) => {
    const { controller, onCommit } = createHarness();
    const stopTrack = vi.fn();
    getUserMedia.mockResolvedValue({
      getTracks: () => [Object.assign(new EventTarget(), { stop: stopTrack })],
    });

    try {
      expect(controller.startDirect()).toBe(true);
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("talk.session.create", expect.anything()),
      );
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(controller.active).toBe(true);
      emit({ transcriptionSessionId: "dictation-1", type: "partial", text: "discard me" });

      if (action === "Escape") {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      } else if (action === "blur") {
        window.dispatchEvent(new Event("blur"));
      } else {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      }

      expect(controller.active).toBe(false);
      expect(stopTrack).toHaveBeenCalledOnce();
      expect(onCommit).not.toHaveBeenCalled();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
      );
    } finally {
      controller.dispose();
    }
  });

  it("unlocks immediately and rejects a pending result after a new session starts", async () => {
    let resolveClose: () => void = () => {};
    const close = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    let sessionsCreated = 0;
    request = vi.fn(async (method: string) => {
      if (method === "talk.session.create") {
        const sessionId = `dictation-${++sessionsCreated}`;
        return {
          sessionId,
          transcriptionSessionId: sessionId,
          audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
        };
      }
      if (method === "talk.session.close") {
        return close;
      }
      return { ok: true };
    });
    const { controller, onCommit, target } = createHarness();
    await startHold(target);

    const committed = controller.finishActive();

    expect(controller.active).toBe(false);
    expect(controller.locksComposer).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    try {
      expect(controller.startDirect()).toBe(true);
      await waitForFast(() => expect(sessionsCreated).toBe(2));
      emit({ transcriptionSessionId: "dictation-2", type: "partial", text: "new preview" });
      expect(controller.transcript).toBe("new preview");
      emit({ transcriptionSessionId: "dictation-1", type: "partial", text: "stale preview" });
      expect(controller.transcript).toBe("new preview");
      emit({
        transcriptionSessionId: "dictation-1",
        type: "transcript",
        text: "late final",
        final: true,
      });
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
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onTap).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(controller.locksComposer).toBe(false);

    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onTap).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("returns to idle and classifies microphone startup failures", async () => {
    getUserMedia = vi.fn(async () => {
      throw new DOMException("blocked", "NotAllowedError");
    });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia });
    const { controller, onError, target } = createHarness();

    target.dispatchEvent(pointer("pointerdown"));
    await vi.advanceTimersByTimeAsync(500);
    await waitForFast(() =>
      expect(onError).toHaveBeenCalledWith(
        "Microphone access is blocked. Allow it in browser site settings to list inputs.",
        { kind: "start", preservesText: false },
      ),
    );

    expect(controller.active).toBe(false);
    expect(controller.locksComposer).toBe(false);
    expect(request).not.toHaveBeenCalledWith("talk.session.create", expect.anything());
    controller.dispose();
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
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onTap).toHaveBeenCalledOnce();
    expect(controller.locksComposer).toBe(false);
    controller.dispose();
  });

  it("streams g711_ulaw audio and commits final transcript from latched Stop", async () => {
    const order: string[] = [];
    getUserMedia = vi.fn(async () => {
      order.push("microphone");
      return { getTracks: () => [Object.assign(new EventTarget(), { stop: vi.fn() })] };
    });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: getUserMedia });
    request = vi.fn(async (method: string, params: unknown) => {
      order.push(method);
      if (method === "talk.session.create") {
        return {
          sessionId: "dictation-1",
          transcriptionSessionId: "dictation-1",
          audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
        };
      }
      return params;
    });
    const { controller, onCommit, target } = createHarness();

    await startHold(target);
    expect(order.slice(0, 2)).toEqual(["microphone", "talk.session.create"]);
    const processor = processors.at(-1);
    if (!processor) {
      throw new Error("expected microphone processor");
    }
    processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array([0, 1, -1]) },
    });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.appendAudio", {
        sessionId: "dictation-1",
        audioBase64: "/4AA",
      }),
    );
    emit({
      transcriptionSessionId: "dictation-1",
      type: "partial",
      text: "hello wor",
    });
    expect(controller.transcript).toBe("hello wor");
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "hello world",
      final: true,
    });
    await commitLatched(controller, target);
    expect(controller.finalizing).toBe(false);
    expect(onCommit).toHaveBeenCalledWith("hello world");
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" });
    expect(order.indexOf("talk.session.appendAudio")).toBeLessThan(
      order.indexOf("talk.session.close"),
    );
    controller.dispose();
  });

  it("reports whether the immediate snapshot committed a transcript", async () => {
    const withTranscript = createHarness();
    await startHold(withTranscript.target);
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "send these words",
      final: true,
    });
    const committed = withTranscript.controller.finishActive();
    await expect(committed).resolves.toBe(true);
    withTranscript.controller.dispose();

    const withoutTranscript = createHarness();
    await startHold(withoutTranscript.target);
    const empty = withoutTranscript.controller.finishActive();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(empty).resolves.toBe(false);
    withoutTranscript.controller.dispose();
  });

  it("buffers microphone audio while the transcription session is being created", async () => {
    const order: string[] = [];
    let resolveCreate: (result: {
      sessionId: string;
      transcriptionSessionId: string;
      audio: { inputEncoding: string; inputSampleRateHz: number };
    }) => void = () => undefined;
    const createResult = new Promise<{
      sessionId: string;
      transcriptionSessionId: string;
      audio: { inputEncoding: string; inputSampleRateHz: number };
    }>((resolve) => {
      resolveCreate = resolve;
    });
    request = vi.fn(async (method: string, params: unknown) => {
      order.push(method);
      if (method === "talk.session.create") {
        return createResult;
      }
      return params;
    });
    const { controller, onCommit, target } = createHarness();
    await startHold(target);
    const processor = processors.at(-1);
    if (!processor) {
      throw new Error("expected microphone processor before session creation completes");
    }
    processor.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array([0, 1, -1]) },
    });
    expect(request).not.toHaveBeenCalledWith("talk.session.appendAudio", expect.anything());

    await commitLatched(controller, target);
    resolveCreate({
      sessionId: "late-session",
      transcriptionSessionId: "late-session",
      audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
    });

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.appendAudio", {
        sessionId: "late-session",
        audioBase64: "/4AA",
      }),
    );
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "late-session" }),
    );
    expect(order.indexOf("talk.session.appendAudio")).toBeLessThan(
      order.indexOf("talk.session.close"),
    );
    expect(onCommit).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("bounds Stop while transcription session creation remains pending", async () => {
    let resolveCreate: (result: {
      sessionId: string;
      transcriptionSessionId: string;
      audio: { inputEncoding: string; inputSampleRateHz: number };
    }) => void = () => undefined;
    const createResult = new Promise<{
      sessionId: string;
      transcriptionSessionId: string;
      audio: { inputEncoding: string; inputSampleRateHz: number };
    }>((resolve) => {
      resolveCreate = resolve;
    });
    request = vi.fn(async (method: string) =>
      method === "talk.session.create" ? createResult : { ok: true },
    );
    const { controller, target } = createHarness();
    await startHold(target);

    const finished = controller.finishActive();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(finished).resolves.toBe(false);
    expect(controller.locksComposer).toBe(false);
    expect(request).not.toHaveBeenCalledWith("talk.session.close", expect.anything());

    resolveCreate({
      sessionId: "late-session",
      transcriptionSessionId: "late-session",
      audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
    });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "late-session" }),
    );
    controller.dispose();
  });

  it("closes a late session in background after latched Stop", async () => {
    let resolveCreate: (result: {
      sessionId: string;
      transcriptionSessionId: string;
      audio: { inputEncoding: string; inputSampleRateHz: number };
    }) => void = () => undefined;
    const createResult = new Promise<{
      sessionId: string;
      transcriptionSessionId: string;
      audio: { inputEncoding: string; inputSampleRateHz: number };
    }>((resolve) => {
      resolveCreate = resolve;
    });
    request = vi.fn(async (method: string) => {
      if (method === "talk.session.create") {
        return createResult;
      }
      return { ok: true };
    });
    const { controller, onError, target } = createHarness();
    await startHold(target);

    await commitLatched(controller, target);
    resolveCreate({
      sessionId: "late-session",
      transcriptionSessionId: "late-session",
      audio: { inputEncoding: "unsupported", inputSampleRateHz: 48_000 },
    });

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "late-session" }),
    );
    expect(onError).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("commits final text promptly when the Gateway disconnects during a partial drain", async () => {
    const harness = createHarness();
    await startHold(harness.target);
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "keep this",
      final: true,
    });
    emit({
      transcriptionSessionId: "dictation-1",
      type: "partial",
      text: "unfinished",
    });

    const disconnectedAt = Date.now();
    harness.controller.update({ ...harness.options, connected: false });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    await waitForFast(() => expect(harness.onCommit).toHaveBeenCalledWith("keep this unfinished"));
    expect(Date.now() - disconnectedAt).toBeLessThan(1000);
    expect(harness.onError).toHaveBeenCalledWith(
      "Dictation stopped because the Gateway disconnected.",
      { kind: "interrupted", preservesText: true },
    );
    expect(harness.onError).toHaveBeenCalledTimes(1);
    expect(harness.controller.finalizing).toBe(false);
    expect(harness.controller.locksComposer).toBe(false);
    expect(harness.onError).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" });
    harness.controller.dispose();
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
    settingOff.controller.dispose();
  });
});

describe("composer microphone button", () => {
  it("keeps a latched hold recording after its release click until a separate tap", async () => {
    const { controller, onCommit, onTap, target } = createButtonHarness();
    await startHold(target);
    emit({
      transcriptionSessionId: "dictation-1",
      type: "transcript",
      text: "keep recording",
      final: true,
    });

    await releaseLatched(target);
    expect(controller.active).toBe(true);
    expect(request).not.toHaveBeenCalledWith("talk.session.close", expect.anything());
    expect(onCommit).not.toHaveBeenCalled();

    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.session.close", { sessionId: "dictation-1" }),
    );
    expect(onCommit).toHaveBeenCalledWith("keep recording");
    expect(controller.active).toBe(false);
    expect(onTap).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("keeps a quick tap as the tap action", async () => {
    const { controller, onTap, target } = createButtonHarness();

    target.dispatchEvent(pointer("pointerdown"));
    document.dispatchEvent(pointer("pointerup"));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(300);

    expect(onTap).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(controller.locksComposer).toBe(false);
    controller.dispose();
  });
});

describe("insertComposerDictation", () => {
  it("inserts at the selection and joins surrounding text with sensible spaces", () => {
    expect(insertComposerDictation("hello world", "brave new", 6, 6)).toEqual({
      value: "hello brave new world",
      caret: 16,
    });
    expect(insertComposerDictation("hello world", "there", 6, 11)).toEqual({
      value: "hello there",
      caret: 11,
    });
  });
});
