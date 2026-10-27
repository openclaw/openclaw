// @vitest-environment jsdom
import { createEffect, createRoot, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { loadSettings, saveSettings } from "../../app/settings.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { GatewaySpeechPlayback } from "../../lib/speech-playback.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  attachChatRealtimeActions,
  createInitialChatRealtimeState,
  dismissRealtimeTalkError,
  stopChatRealtimeTalk,
  type ChatRealtimeState,
} from "./chat-realtime.ts";
import { RealtimeTalkSelectedMicrophoneError } from "./talk/input.ts";
import { RealtimeTalkSession } from "./talk/session.ts";
import type { RealtimeTalkCallbacks } from "./talk/shared.ts";

type InspectableRealtimeTalkSession = {
  callbacks: RealtimeTalkCallbacks;
  options: { provider?: string; transport?: string };
  localOptions: { inputDeviceId?: string; videoDeviceId?: string };
};

let state: ChatRealtimeState;

function inspectSession(): InspectableRealtimeTalkSession {
  const session = read().realtimeTalkSession;
  if (!session) {
    throw new Error("expected realtime session");
  }
  return session as unknown as InspectableRealtimeTalkSession;
}

async function start() {
  await state.toggleRealtimeTalk();
  const session = inspectSession();
  return { session, callbacks: session.callbacks };
}

function mockVideo() {
  return vi.spyOn(RealtimeTalkSession.prototype, "setVideoEnabled").mockResolvedValue(undefined);
}

async function startVideo() {
  const { session } = await start();
  session.callbacks.onVideoCapability?.(true);
  return session;
}

function configure(settings: Partial<ReturnType<typeof loadSettings>>) {
  saveSettings({ ...loadSettings(), ...settings });
}

function transcript(callbacks: RealtimeTalkCallbacks, text: string) {
  callbacks.onTranscript?.({ role: "user", text, final: true, itemId: "same", order: 0 });
}

function read() {
  return state.realtimeTalk.snapshot;
}

function entries() {
  return read().realtimeTalkConversationState.entries;
}

function preview(nextDeviceId: string, label: string) {
  const stream = {
    getVideoTracks: () => [{ getSettings: () => ({ deviceId: "front" }) } as MediaStreamTrack],
  } as unknown as MediaStream;
  state.realtimeTalk.update({
    realtimeTalkVideoStream: stream,
    realtimeTalkCameraDevices: [
      { deviceId: "front", label: "Front Camera" },
      { deviceId: nextDeviceId, label },
    ],
  });
  return stream;
}

let startSpy: MockInstance<RealtimeTalkSession["start"]>;
let prepareSpy: MockInstance<GatewaySpeechPlayback["prepare"]>;

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  prepareSpy = vi
    .spyOn(GatewaySpeechPlayback.prototype, "prepare")
    .mockImplementation(() => document.createElement("audio"));
  startSpy = vi.spyOn(RealtimeTalkSession.prototype, "start").mockResolvedValue(undefined);
  vi.spyOn(RealtimeTalkSession.prototype, "stop").mockResolvedValue(undefined);
  vi.spyOn(RealtimeTalkSession.prototype, "switchCamera").mockResolvedValue(undefined);
  state = {
    client: {
      request: vi.fn(async () => ({ config: {} })),
      addEventListener: vi.fn(() => () => undefined),
    },
    connected: true,
    sessionKey: "main",
    chatMessages: [],
    ...createInitialChatRealtimeState(),
  } as unknown as ChatRealtimeState;
  attachChatRealtimeActions(state);
});

afterEach(() => {
  vi.restoreAllMocks();
  saveSettings(loadSettings());
  localStorage.clear();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "changes only audio while retaining captions and effective microphone (default recovery: %s)",
  async (useSystemDefault) => {
    configure({ realtimeTalkInputDeviceId: "usb-mic" });
    const listeners = new Set<(event: GatewayEventFrame) => void>();
    const request = vi.fn(async () => ({ ok: true }));
    state.client = {
      request,
      addEventListener: (listener: (event: GatewayEventFrame) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as ChatRealtimeState["client"];
    let creates = 0;
    const ids = new WeakMap<RealtimeTalkSession, string>();
    startSpy.mockImplementation(async function (this: RealtimeTalkSession) {
      ids.set(this, `voice-${++creates}`);
    });
    vi.spyOn(RealtimeTalkSession.prototype, "getVoiceSessionId").mockImplementation(function (
      this: RealtimeTalkSession,
    ) {
      return ids.get(this);
    });
    vi.spyOn(RealtimeTalkSession.prototype, "getTransport").mockReturnValue("webrtc");
    if (useSystemDefault) {
      startSpy.mockRejectedValueOnce(new RealtimeTalkSelectedMicrophoneError());
    }
    await state.toggleRealtimeTalk();
    if (useSystemDefault) {
      await read().realtimeTalkUseSystemDefault!();
    }
    const oldSession = read().realtimeTalkSession!;
    const old = inspectSession();
    transcript(old.callbacks, "Old speech");
    old.callbacks.onTranscript?.({ role: "assistant", text: "Still speaking", final: false });
    state.realtimeTalk.update({ realtimeTalkVideoStream: {} as MediaStream });
    state.realtimeTalk.update({
      realtimeTalkCameraDevices: [{ deviceId: "old-camera", label: "Old camera" }],
    });
    for (const listener of listeners) {
      listener({
        type: "event",
        event: "talk.voice.change",
        payload: {
          sessionKey: "main",
          voiceSessionId: "voice-1",
          voice: "spruce",
          changeId: "change-1",
          phase: "requested",
        },
      });
    }
    await vi.waitFor(() => expect(creates).toBe(2));
    expect(state.sessionKey).toBe("main");
    expect(read().realtimeTalkSession).not.toBe(oldSession);
    expect(read()).toMatchObject({
      realtimeTalkVideoStream: null,
      realtimeTalkCameraDevices: [],
    });
    expect(inspectSession().options).toMatchObject({
      voice: "spruce",
      voiceChangeId: "change-1",
      transport: "webrtc",
    });
    const replacement = inspectSession();
    expect(replacement.localOptions.inputDeviceId).toBe(useSystemDefault ? undefined : "usb-mic");
    transcript(replacement.callbacks, "New speech");
    replacement.callbacks.onTranscriptOrder?.([{ itemId: "same", order: 0 }]);
    transcript(old.callbacks, "Late old speech");
    expect(entries().map(({ text }) => text)).toEqual([
      "Old speech",
      "Still speaking",
      "New speech",
    ]);
    expect(new Set(entries().map(({ id }) => id)).size).toBe(3);
    expect(entries().every(({ isStreaming }) => !isStreaming)).toBe(true);
    expect(request.mock.calls).toEqual(
      Array.from({ length: useSystemDefault ? 2 : 1 }, () => ["talk.config", {}]),
    );
    replacement.callbacks.onTalkEvent?.({
      type: "session.ready",
    });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "talk.voice.complete",
        { changeId: "change-1", voiceSessionId: "voice-2", outcome: "ready" },
        { timeoutMs: 70_000 },
      ),
    );
    await state.toggleRealtimeTalk();
    expect(entries()).toEqual([]);
    expect(listeners.size).toBe(0);
  },
);

it.each([false, true])("launches with persisted devices (blocked storage: %s)", async (blocked) => {
  if (blocked) {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
  }
  configure({ realtimeTalkInputDeviceId: "usb-mic", realtimeTalkVideoDeviceId: "desk-camera" });
  await start();
  expect(inspectSession().localOptions).toMatchObject({
    inputDeviceId: "usb-mic",
    videoDeviceId: "desk-camera",
  });
  expect(startSpy).toHaveBeenCalledOnce();
});

it("requires explicit one-shot consent and preserves the saved microphone for later calls", async () => {
  configure({ realtimeTalkInputDeviceId: "usb-mic" });
  startSpy.mockRejectedValueOnce(new RealtimeTalkSelectedMicrophoneError());
  await state.toggleRealtimeTalk();
  const retry = read().realtimeTalkUseSystemDefault;
  expect(retry).toBeTypeOf("function");
  expect(startSpy).toHaveBeenCalledOnce();
  expect(read().realtimeTalkActive).toBe(false);
  await Promise.all([retry!(), retry!()]);
  expect(startSpy).toHaveBeenCalledTimes(2);
  expect(inspectSession().localOptions.inputDeviceId).toBeUndefined();
  expect(read().realtimeTalkUseSystemDefault).toBeNull();
  expect(loadSettings().realtimeTalkInputDeviceId).toBe("usb-mic");
  await state.toggleRealtimeTalk();
  await state.toggleRealtimeTalk();
  expect(inspectSession().localOptions.inputDeviceId).toBe("usb-mic");
});

it.each(["dismiss", "route", "disconnect", "reconnect", "replacement"] as const)(
  "revokes retained microphone recovery after %s",
  async (event) => {
    startSpy.mockRejectedValueOnce(new RealtimeTalkSelectedMicrophoneError());
    await state.toggleRealtimeTalk();
    const retry = read().realtimeTalkUseSystemDefault!;
    if (event === "dismiss") {
      dismissRealtimeTalkError(state);
    } else if (event === "route") {
      state.sessionKey = "another-session";
    } else if (event === "disconnect") {
      state.connected = false;
    } else if (event === "reconnect") {
      stopChatRealtimeTalk(state);
      state.connected = true;
    } else {
      await state.toggleRealtimeTalk();
    }
    const calls = startSpy.mock.calls.length;
    await retry();
    // A rejected stale activation stays consumed even if the context returns.
    state.connected = true;
    state.sessionKey = "main";
    await retry();
    expect(startSpy).toHaveBeenCalledTimes(calls);
  },
);

it.each(["failed", "cancelled", "succeeded"] as const)(
  "does not overwrite a newer preference when explicit recovery %s",
  async (outcome) => {
    configure({ realtimeTalkInputDeviceId: "usb-mic" });
    startSpy.mockRejectedValueOnce(new RealtimeTalkSelectedMicrophoneError());
    await state.toggleRealtimeTalk();
    let finish!: () => void;
    startSpy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve, reject) => {
          finish = () =>
            outcome === "failed" ? reject(new Error("Microphone access is blocked")) : resolve();
        }),
    );
    const retry = read().realtimeTalkUseSystemDefault!();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(inspectSession().localOptions.inputDeviceId).toBeUndefined();
    configure({ realtimeTalkInputDeviceId: "newer-mic" });
    if (outcome === "cancelled") {
      stopChatRealtimeTalk(state);
    }
    finish();
    await retry;
    expect(loadSettings().realtimeTalkInputDeviceId).toBe("newer-mic");
    expect(read().realtimeTalkUseSystemDefault).toBeNull();
    if (outcome === "failed") {
      expect(read().realtimeTalkDetail).toBe("Microphone access is blocked");
    }
  },
);

it("does not infer microphone recovery from error text", async () => {
  startSpy.mockRejectedValueOnce(new Error(new RealtimeTalkSelectedMicrophoneError().message));
  await state.toggleRealtimeTalk();
  expect(read()).toMatchObject({
    realtimeTalkStatus: "error",
    realtimeTalkUseSystemDefault: null,
  });
});

it("enables camera only after a video-capable voice session starts", async () => {
  const setVideoEnabled = mockVideo();
  const session = await startVideo();
  const stream = {} as MediaStream;
  await state.toggleRealtimeTalkCamera();
  session.callbacks.onVideoStream?.(stream);

  expect(session.options.provider).toBeUndefined();
  expect(session.options.transport).toBeUndefined();
  expect(setVideoEnabled).toHaveBeenCalledWith(true);
  expect(read().realtimeTalkVideoStream).toBe(stream);
  expect(loadSettings().talkCameraAutoEnable).toBe(true);

  await state.toggleRealtimeTalkCamera();
  expect(setVideoEnabled).toHaveBeenLastCalledWith(false);
  session.callbacks.onVideoStream?.(null);
  expect(read().realtimeTalkVideoStream).toBeNull();
  expect(loadSettings().talkCameraAutoEnable).toBe(false);
});

it.each([
  { preference: true, status: "listening" },
  { preference: true, status: "error" },
  { preference: undefined, status: "listening" },
  { preference: false, status: "listening" },
] as const)(
  "auto-enable respects preference=$preference and status=$status",
  async ({ preference, status }) => {
    configure({ talkCameraAutoEnable: preference });
    const setVideoEnabled = mockVideo();
    const session = await startVideo();
    if (preference && status === "listening") {
      await Promise.resolve();
      expect(setVideoEnabled).not.toHaveBeenCalled();
      session.callbacks.onStatus?.("listening");
      session.callbacks.onStatus?.("listening");
      await vi.waitFor(() => expect(setVideoEnabled).toHaveBeenCalledOnce());
      expect(setVideoEnabled).toHaveBeenCalledWith(true);
    } else {
      session.callbacks.onStatus?.(
        status,
        status === "error" ? "Microphone access failed" : undefined,
      );
      await Promise.resolve();
      expect(setVideoEnabled).not.toHaveBeenCalled();
      if (status === "error") {
        expect(loadSettings().talkCameraAutoEnable).toBe(true);
      }
    }
  },
);

it("uses the latest Settings camera choice on the next enable", async () => {
  const switchCamera = vi.spyOn(RealtimeTalkSession.prototype, "switchCamera");
  mockVideo();

  await startVideo();
  configure({ realtimeTalkVideoDeviceId: "back-camera" });
  await state.toggleRealtimeTalkCamera();

  expect(switchCamera).toHaveBeenCalledWith("back-camera");
});

it.each([false, true])(
  "surfaces camera failure without ending voice (automatic: %s)",
  async (automatic) => {
    if (automatic) {
      configure({ talkCameraAutoEnable: true });
    }
    vi.spyOn(RealtimeTalkSession.prototype, "setVideoEnabled").mockRejectedValue(
      new Error("Camera access is blocked"),
    );
    const { callbacks } = await startVideo();
    callbacks.onStatus?.("listening");
    if (automatic) {
      await vi.waitFor(() => expect(read().realtimeTalkCameraError).toBe(true));
      expect(loadSettings().talkCameraAutoEnable).toBe(false);
    } else {
      await state.toggleRealtimeTalkCamera();
      expect(read().realtimeTalkSession).not.toBeNull();
      expect(read()).toMatchObject({
        realtimeTalkActive: true,
        realtimeTalkStatus: "listening",
        realtimeTalkVideoStream: null,
        realtimeTalkCameraError: true,
      });
    }
    expect(read().realtimeTalkDetail).toBe("Camera access is blocked");
  },
);

it("does not change the remembered preference when the camera track ends", async () => {
  mockVideo();

  const session = await startVideo();
  await state.toggleRealtimeTalkCamera();
  session.callbacks.onVideoStream?.({} as MediaStream);
  expect(loadSettings().talkCameraAutoEnable).toBe(true);

  session.callbacks.onVideoStream?.(null);

  expect(read().realtimeTalkVideoStream).toBeNull();
  expect(loadSettings().talkCameraAutoEnable).toBe(true);
});

it("does not let a stale camera-off completion overwrite a newer camera stream", async () => {
  const cameraOff = createDeferred();
  const setVideoEnabled = vi
    .spyOn(RealtimeTalkSession.prototype, "setVideoEnabled")
    .mockImplementation((enabled) => (enabled ? Promise.resolve() : cameraOff.promise));

  const firstSession = await startVideo();
  await state.toggleRealtimeTalkCamera();
  firstSession.callbacks.onVideoStream?.({} as MediaStream);

  const disabling = state.toggleRealtimeTalkCamera();
  expect(loadSettings().talkCameraAutoEnable).toBe(false);
  await state.toggleRealtimeTalk();
  const secondSession = await startVideo();
  await state.toggleRealtimeTalkCamera();
  secondSession.callbacks.onVideoStream?.({} as MediaStream);
  expect(loadSettings().talkCameraAutoEnable).toBe(true);

  cameraOff.resolve();
  await disabling;

  expect(setVideoEnabled).toHaveBeenCalledTimes(3);
  expect(loadSettings().talkCameraAutoEnable).toBe(true);
});

it("cycles live cameras in enumeration order and persists the successful switch", async () => {
  const switchCamera = vi
    .spyOn(RealtimeTalkSession.prototype, "switchCamera")
    .mockResolvedValue(undefined);

  await state.toggleRealtimeTalk();
  preview("back", "Back Camera");

  await state.switchRealtimeTalkCamera();

  expect(switchCamera).toHaveBeenCalledWith("back");
  expect(loadSettings().realtimeTalkVideoDeviceId).toBe("back");
  expect(read().realtimeTalkCameraError).toBe(false);
});

it("keeps the restored preview and reports a failed live camera switch", async () => {
  vi.spyOn(RealtimeTalkSession.prototype, "switchCamera").mockRejectedValue(
    new Error("The selected camera is unavailable"),
  );

  await state.toggleRealtimeTalk();
  const stream = preview("missing", "Missing Camera");
  await state.switchRealtimeTalkCamera();

  expect(read().realtimeTalkVideoStream).toBe(stream);
  expect(read()).toMatchObject({
    realtimeTalkCameraError: true,
    realtimeTalkDetail: "The selected camera is unavailable",
  });
  expect(loadSettings().realtimeTalkVideoDeviceId).toBeUndefined();
});

it.each(["before toggle", "during rejection", "during stream"] as const)(
  "keeps connection failure authoritative %s",
  async (timing) => {
    const pending = createDeferred();
    const setVideoEnabled = mockVideo();
    if (timing === "during rejection") {
      setVideoEnabled.mockImplementation(() => pending.promise);
    } else if (timing === "during stream") {
      setVideoEnabled.mockImplementation((enabled) =>
        enabled ? pending.promise : Promise.resolve(),
      );
    }
    const session = await startVideo();
    session.callbacks.onStatus?.(
      timing === "before toggle" ? "error" : "listening",
      timing === "before toggle" ? "Realtime connection closed" : undefined,
    );
    const toggling = state.toggleRealtimeTalkCamera();
    if (timing !== "before toggle") {
      await Promise.resolve();
      session.callbacks.onStatus?.("error", "Realtime connection closed");
      if (timing === "during rejection") {
        pending.reject(new Error("Camera access is blocked"));
      } else {
        session.callbacks.onVideoStream?.({} as MediaStream);
        pending.resolve();
      }
    }
    await toggling;
    expect(read()).toMatchObject({
      realtimeTalkDetail: "Realtime connection closed",
      realtimeTalkCameraError: false,
    });
    if (timing === "before toggle") {
      expect(setVideoEnabled).not.toHaveBeenCalled();
    }
    if (timing === "during stream") {
      expect(setVideoEnabled).toHaveBeenLastCalledWith(false);
      expect(read().realtimeTalkVideoStream).toBeNull();
    }
  },
);

it("re-reads the persisted microphone on every launch instead of caching it", async () => {
  await start();
  expect(inspectSession().localOptions.inputDeviceId).toBeUndefined();
  await state.toggleRealtimeTalk();

  configure({ realtimeTalkInputDeviceId: "usb-mic" });
  await state.toggleRealtimeTalk();

  expect(inspectSession().localOptions.inputDeviceId).toBe("usb-mic");
});

it("publishes call transitions and transcript changes through the owner projection", async () => {
  const observed: Array<{ status: string; text: string; notice: string | null }> = [];
  const dispose = createRoot((stop) => {
    const realtime = projectOwner(state.realtimeTalk, (owner) => owner.snapshot);
    createEffect(
      () => {
        const snapshot = realtime.read();
        return {
          status: snapshot.realtimeTalkStatus,
          text: snapshot.realtimeTalkConversationState.entries.map((entry) => entry.text).join(" "),
          notice: snapshot.realtimeTalkInputNotice,
        };
      },
      (snapshot) => {
        observed.push(snapshot);
      },
    );
    return stop;
  });
  try {
    flush();
    await state.toggleRealtimeTalk();
    const { callbacks } = inspectSession();
    callbacks.onStatus?.("listening");
    callbacks.onTranscript?.({ role: "user", text: "Hello", final: true });
    callbacks.onInputNotice?.("Microphone recovered");
    expect(read().realtimeTalkStatus).toBe("listening");
    expect(entries()[0]?.text).toBe("Hello");
    flush();
    expect(observed.at(-1)).toEqual({
      status: "listening",
      text: "Hello",
      notice: "Microphone recovered",
    });
    stopChatRealtimeTalk(state);
    flush();
    expect(observed.at(-1)).toEqual({ status: "idle", text: "", notice: null });
  } finally {
    dispose();
  }
});

it("propagates normalized microphone levels and resets them on error", async () => {
  const { callbacks } = await start();
  const updated = vi.fn();
  const unsubscribe = state.realtimeTalk.subscribe(updated);
  callbacks.onInputLevel?.(0.456);
  expect(read().realtimeTalkInputLevel.value).toBe(0.46);

  callbacks.onInputLevel?.(2);
  expect(read().realtimeTalkInputLevel.value).toBe(1);
  expect(updated).not.toHaveBeenCalled();
  unsubscribe();

  callbacks.onStatus?.("error", "capture failed");
  expect(read().realtimeTalkInputLevel.value).toBe(0);
});

it.each([
  { kind: "rewrite", partial: "Can you tack", final: "Can you check?" },
  { kind: "new turn", partial: "First request", final: "Second request" },
])("places a late user final correctly for a $kind", async ({ kind, partial, final }) => {
  const { callbacks } = await start();
  callbacks.onTranscript?.({ role: "user", text: partial, final: false });
  callbacks.onTranscript?.({ role: "assistant", text: "Checking", final: false });
  callbacks.onTranscript?.({ role: "user", text: final, final: true });
  expect(entries()).toMatchObject(
    kind === "rewrite"
      ? [
          { role: "user", text: final, isStreaming: false },
          { role: "assistant", text: "Checking", isStreaming: true },
        ]
      : [
          { role: "user", text: partial, isStreaming: false },
          { role: "assistant", text: "Checking", isStreaming: false },
          { role: "user", text: final, isStreaming: false },
        ],
  );
});

it.each([false, true])(
  "retires failed startup state without touching a replacement (%s)",
  async (replaced) => {
    const pending = createDeferred<undefined>();
    startSpy.mockImplementationOnce(() => pending.promise);
    const starting = state.toggleRealtimeTalk();
    await vi.waitFor(() => expect(read().realtimeTalkSession).not.toBeNull());
    const { callbacks } = inspectSession();
    let replacement: InspectableRealtimeTalkSession | null = null;
    const publishPartial = () => {
      callbacks.onVideoCapability?.(true);
      callbacks.onInputLevel?.(replaced ? 0.9 : 0.8);
      callbacks.onTranscript?.({
        role: "user",
        text: replaced ? "stale" : "partial",
        final: replaced,
      });
      callbacks.onVideoStream?.({} as MediaStream);
    };
    if (replaced) {
      await state.toggleRealtimeTalk();
      await state.toggleRealtimeTalk();
      replacement = inspectSession();
      replacement.callbacks.onStatus?.("listening");
    } else {
      callbacks.onStatus?.("listening");
      publishPartial();
      state.realtimeTalk.update({
        realtimeTalkCameraDevices: [{ deviceId: "camera", label: "Camera" }],
        realtimeTalkVideoPending: true,
        realtimeTalkCameraError: true,
      });
    }
    pending.reject(new Error(replaced ? "late setup failure" : "startup failed"));
    await starting;
    if (replaced) {
      publishPartial();
      callbacks.onVideoError?.(new Error("stale camera failure"));
      callbacks.onStatus?.("error", "stale failure");
    }
    expect(read().realtimeTalkSession).toBe(replacement);
    expect(read()).toMatchObject({
      realtimeTalkActive: replaced,
      realtimeTalkStatus: replaced ? "listening" : "error",
      realtimeTalkDetail: replaced ? null : "startup failed",
      realtimeTalkVideoStream: null,
      realtimeTalkVideoCapable: false,
      realtimeTalkCameraError: false,
    });
    expect(read().realtimeTalkInputLevel.value).toBe(0);
    expect(entries()).toEqual([]);
    if (!replaced) {
      expect(read()).toMatchObject({
        realtimeTalkCameraDevices: [],
        realtimeTalkVideoPending: false,
      });
    }
  },
);

it("retires callback ownership before stopping a session", async () => {
  await start();
  const firstSession = inspectSession();
  const stop = vi
    .spyOn(RealtimeTalkSession.prototype, "stop")
    .mockImplementationOnce(async () => firstSession.callbacks.onStatus?.("error", "late stop"));

  await state.toggleRealtimeTalk();

  expect(stop).toHaveBeenCalledOnce();
  expect(read()).toMatchObject({
    realtimeTalkSession: null,
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle",
    realtimeTalkDetail: null,
  });
});

it.each(["stop", "route", "disconnect"] as const)(
  "prepares gesture audio synchronously and rejects a %s during the lazy runtime load",
  async (change) => {
    type Runtime = typeof import("./talk/chat-actions-runtime.ts");
    const loaded = createDeferred<Runtime>();
    const loading = createDeferred();
    const startChatRealtimeSession = vi.fn<Runtime["startChatRealtimeSession"]>();
    // mock-isolation: Hold module evaluation open to prove cancellation before the voice runtime loads.
    vi.doMock("./talk/chat-actions-runtime.ts", () => {
      loading.resolve();
      return loaded.promise;
    });
    const starting = state.toggleRealtimeTalk();
    try {
      expect(prepareSpy).toHaveBeenCalledOnce();
      expect(read().realtimeTalkStatus).toBe("connecting");
      await loading.promise;
      if (change === "stop") {
        await state.toggleRealtimeTalk();
      } else if (change === "route") {
        state.sessionKey = "another-session";
      } else {
        state.connected = false;
      }
      loaded.resolve({
        startChatRealtimeSession,
        setRealtimeTalkCameraEnabled: vi.fn(),
        switchRealtimeTalkCamera: vi.fn(),
      });
      await starting;
      expect(startChatRealtimeSession).not.toHaveBeenCalled();
      expect(startSpy).not.toHaveBeenCalled();
      expect(read().realtimeTalkSession).toBeNull();
      expect(read().realtimeTalkActive).toBe(false);
    } finally {
      vi.doUnmock("./talk/chat-actions-runtime.ts");
    }
  },
);
