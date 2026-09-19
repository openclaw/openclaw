/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createComposerProps as props,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer.ts";
import * as realtimeTalkInput from "./talk/input.ts";

const discoverRealtimeTalkInputsMock = vi.fn();
const openMicrophoneMock = vi.fn();

type GatewayListener = (frame: { event: string; payload: unknown }) => void;

class DictationAudioContext {
  readonly destination = {};
  readonly sampleRate = 8000;
  readonly close = vi.fn(async () => undefined);

  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }

  createScriptProcessor() {
    return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
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

function dictationPointer(type: "pointerdown" | "pointerup", pointerId: number): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event as PointerEvent;
}

/**
 * A composer wired to a Gateway that answers dictation calls. The page re-renders
 * off the frame loop rather than inside the click handler, so a commit still sees
 * whichever value the live preview has already put in the textarea.
 */
function dictationComposer() {
  const listeners = new Set<GatewayListener>();
  const createdSessions: string[] = [];
  const request = vi.fn(async (method: string) => {
    if (method === "talk.catalog") {
      return { transcription: { ready: true } };
    }
    if (method === "talk.session.create") {
      const sessionId = `dictation-${createdSessions.length + 1}`;
      createdSessions.push(sessionId);
      return {
        sessionId,
        transcriptionSessionId: sessionId,
        audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
      };
    }
    return { ok: true };
  });
  const gatewayClient = {
    addEventListener: vi.fn((listener: GatewayListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    request,
  } as unknown as GatewayBrowserClient;
  const container = document.createElement("div");
  document.body.append(container);
  const onDraftChange = vi.fn();
  const composerProps = props({
    draft: "",
    gatewayClient,
    onDraftChange,
    onToggleRealtimeTalk: vi.fn(),
  });
  // The page mirrors committed drafts back into the composer props.
  onDraftChange.mockImplementation((value: string) => {
    composerProps.draft = value;
  });
  const draw = () => render(renderChatComposer(composerProps), container);
  composerProps.onRequestUpdate = () => {
    void Promise.resolve().then(draw);
  };
  return {
    container,
    createdSessions,
    draw,
    drafts: () => onDraftChange.mock.calls.map(([value]) => value),
    emitFinal: (text: string, transcriptionSessionId = createdSessions.at(-1)) => {
      for (const listener of listeners) {
        listener({
          event: "talk.event",
          payload: {
            transcriptionSessionId,
            type: "transcript",
            text,
            final: true,
          },
        });
      }
    },
    microphone: (selector: string) => {
      const button = container.querySelector<HTMLButtonElement>(selector);
      if (!button) {
        throw new Error(`expected dictation microphone ${selector}`);
      }
      return button;
    },
    onDraftChange,
    request,
    textarea: () => {
      const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
      if (!textarea) {
        throw new Error("expected composer textarea");
      }
      return textarea;
    },
  };
}

/** Flushes the deferred page render and the Gateway round trips it schedules. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  // ESM imports remain live when the composer was cached by another test file.
  // Patch the shared dependencies instead of clearing isolate:false's registry.
  vi.spyOn(realtimeTalkInput, "discoverRealtimeTalkInputs").mockImplementation(
    discoverRealtimeTalkInputsMock,
  );
  vi.spyOn(realtimeTalkInput.RealtimeTalkInputController.prototype, "open").mockImplementation(
    openMicrophoneMock,
  );
});

afterEach(async () => {
  await resetComposerFixture(() => {
    discoverRealtimeTalkInputsMock.mockReset();
    openMicrophoneMock.mockReset();
  });
});

describe("chat composer dictation commit", () => {
  it("keeps one copy of the transcript when the release click and a second stop both dispatch", async () => {
    vi.useFakeTimers();
    discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
    openMicrophoneMock.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
    vi.stubGlobal("AudioContext", DictationAudioContext);
    const composer = dictationComposer();
    composer.draw();
    await vi.waitFor(() => expect(composer.request).toHaveBeenCalledWith("talk.catalog", {}));
    await settle();

    const textarea = composer.textarea();
    textarea.value = "ship it";
    textarea.setSelectionRange(5, 5);

    const microphone = composer.microphone(".chat-talk-control > openclaw-tooltip > button");
    Object.defineProperties(microphone, {
      setPointerCapture: { value: () => undefined },
      hasPointerCapture: { value: () => false },
      releasePointerCapture: { value: () => undefined },
    });
    microphone.dispatchEvent(dictationPointer("pointerdown", 33));
    await vi.advanceTimersByTimeAsync(500);
    expect(composer.request).toHaveBeenCalledWith("talk.session.create", expect.anything());
    await settle();
    composer.emitFinal("please");
    await settle();
    // iOS Safari dispatches the compatibility click once the release has passed
    // the suppression window, which stops the dictation and commits the snapshot.
    document.dispatchEvent(dictationPointer("pointerup", 33));
    await settle();
    microphone.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();

    expect(composer.drafts()).toEqual(["ship please it"]);
    expect(composer.textarea().value).toBe("ship please it");
  });

  it("inserts one copy when the mobile microphone starts dictation without a hold", async () => {
    vi.useFakeTimers();
    discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
    openMicrophoneMock.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
    vi.stubGlobal("AudioContext", DictationAudioContext);
    const composer = dictationComposer();
    composer.draw();
    await vi.waitFor(() => expect(composer.request).toHaveBeenCalledWith("talk.catalog", {}));
    await settle();

    // The mobile control has no hold gesture: the click starts the recording.
    const microphone = composer.microphone(".chat-mobile-dictation-action button");
    microphone.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(composer.createdSessions).toHaveLength(1));
    await settle();
    composer.emitFinal("please");
    await settle();
    // The live preview takes the textarea over, exactly as the page renders it.
    const textarea = composer.textarea();
    expect(textarea.value).toBe("please");

    // Tapping Stop commits the dictation once.
    microphone.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();

    expect(composer.drafts()).toEqual(["please"]);
    expect(textarea.value).toBe("please");
  });

  it("commits the next mobile dictation after the previous one committed", async () => {
    vi.useFakeTimers();
    discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
    openMicrophoneMock.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
    vi.stubGlobal("AudioContext", DictationAudioContext);
    const composer = dictationComposer();
    composer.draw();
    await vi.waitFor(() => expect(composer.request).toHaveBeenCalledWith("talk.catalog", {}));
    await settle();

    const microphone = composer.microphone(".chat-mobile-dictation-action button");
    microphone.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(composer.createdSessions).toHaveLength(1));
    await settle();
    composer.emitFinal("please");
    await settle();
    microphone.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
    expect(composer.drafts()).toEqual(["please"]);

    // The next recording claims the committed draft as its own base and inserts
    // at the caret the first one left behind.
    composer.textarea().setSelectionRange(6, 6);
    microphone.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(composer.createdSessions).toHaveLength(2));
    await settle();
    composer.emitFinal("ship it");
    await settle();
    microphone.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();

    expect(composer.drafts()).toEqual(["please", "please ship it"]);
  });
});
