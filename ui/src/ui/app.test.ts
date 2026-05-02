/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { transcribeChatAudioMock } = vi.hoisted(() => ({
  transcribeChatAudioMock: vi.fn(),
}));

vi.mock("./app-chat.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app-chat.ts")>();
  return {
    ...actual,
    transcribeChatAudio: transcribeChatAudioMock,
  };
});

class MockMediaRecorder extends EventTarget {
  static instances: MockMediaRecorder[] = [];
  static isTypeSupported = vi.fn((mimeType: string) => mimeType === "audio/webm");

  readonly mimeType: string;
  state: RecordingState = "inactive";

  constructor(
    readonly stream: MediaStream,
    options?: MediaRecorderOptions,
  ) {
    super();
    this.mimeType = options?.mimeType ?? "";
    MockMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }

  emitData(data: Blob) {
    const event = new Event("dataavailable") as Event & { data: Blob };
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }

  emitError(message: string) {
    const event = new Event("error") as Event & { error: Error; message: string };
    Object.defineProperty(event, "error", { value: new Error(message) });
    Object.defineProperty(event, "message", { value: message });
    this.dispatchEvent(event);
  }
}

type AppWithDictationInternals = {
  client: unknown;
  connected: boolean;
  chatDictationStatus: string;
  chatDictationDetail: string | null;
  chatDictationChunks: Blob[];
  toggleChatDictation: () => Promise<void>;
  cancelChatDictation: () => void;
};

let originalMediaDevices: PropertyDescriptor | undefined;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createMockStream(track = { stop: vi.fn() }) {
  return {
    getTracks: () => [track],
    track,
  } as unknown as MediaStream & { track: { stop: ReturnType<typeof vi.fn> } };
}

async function createRecordingApp() {
  const { OpenClawApp } = await import("./app.ts");
  const app = new OpenClawApp();
  app.client = { request: vi.fn() } as never;
  app.connected = true;
  return app as unknown as AppWithDictationInternals;
}

describe("OpenClawApp dictation recorder lifecycle", () => {
  beforeEach(() => {
    transcribeChatAudioMock.mockReset();
    transcribeChatAudioMock.mockResolvedValue(null);
    MockMediaRecorder.instances = [];
    MockMediaRecorder.isTypeSupported.mockClear();
    vi.stubGlobal("MediaRecorder", MockMediaRecorder);
    originalMediaDevices = Object.getOwnPropertyDescriptor(globalThis.navigator, "mediaDevices");
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => createMockStream()),
      },
    });
  });

  afterEach(() => {
    if (originalMediaDevices) {
      Object.defineProperty(globalThis.navigator, "mediaDevices", originalMediaDevices);
    } else {
      Reflect.deleteProperty(globalThis.navigator, "mediaDevices");
    }
    vi.unstubAllGlobals();
  });

  it("does not submit collected audio after a recorder error and later stop", async () => {
    const app = await createRecordingApp();
    await app.toggleChatDictation();
    const recorder = MockMediaRecorder.instances[0];

    recorder.emitData(new Blob(["audio"], { type: "audio/webm" }));
    recorder.emitError("microphone failed");
    recorder.emitData(new Blob(["late audio"], { type: "audio/webm" }));
    recorder.stop();

    expect(transcribeChatAudioMock).not.toHaveBeenCalled();
    expect(app.chatDictationStatus).toBe("error");
    expect(app.chatDictationDetail).toBe("microphone failed");
    expect(app.chatDictationChunks).toEqual([]);
  });

  it("releases recorded chunks after copying them for normal transcription", async () => {
    const app = await createRecordingApp();
    await app.toggleChatDictation();
    const recorder = MockMediaRecorder.instances[0];
    recorder.emitData(new Blob(["audio"], { type: "audio/webm" }));
    const transcription = createDeferred<null>();
    transcribeChatAudioMock.mockReturnValueOnce(transcription.promise);

    await app.toggleChatDictation();

    expect(app.chatDictationChunks).toEqual([]);
    expect(transcribeChatAudioMock).toHaveBeenCalledTimes(1);
    expect(transcribeChatAudioMock.mock.calls[0]?.[1]).toMatchObject({
      size: 5,
      type: "audio/webm",
    });
    transcription.resolve(null);
    await transcription.promise;
  });

  it("ignores duplicate starts while microphone permission is pending", async () => {
    const app = await createRecordingApp();
    const pendingUserMedia = createDeferred<MediaStream>();
    const getUserMedia = vi.fn(() => pendingUserMedia.promise);
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const stream = createMockStream();

    const firstStart = app.toggleChatDictation();
    const secondStart = app.toggleChatDictation();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await secondStart;
    expect(app.chatDictationStatus).toBe("starting");

    pendingUserMedia.resolve(stream);
    await firstStart;

    expect(MockMediaRecorder.instances).toHaveLength(1);
    expect(MockMediaRecorder.instances[0].state).toBe("recording");
    expect(stream.track.stop).not.toHaveBeenCalled();

    MockMediaRecorder.instances[0].emitData(new Blob(["audio"], { type: "audio/webm" }));
    MockMediaRecorder.instances[0].stop();

    expect(stream.track.stop).toHaveBeenCalledTimes(1);
    expect(transcribeChatAudioMock).toHaveBeenCalledTimes(1);
  });

  it("stops a microphone stream that resolves after pending dictation is canceled", async () => {
    const app = await createRecordingApp();
    const pendingUserMedia = createDeferred<MediaStream>();
    const getUserMedia = vi.fn(() => pendingUserMedia.promise);
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const stream = createMockStream();

    const start = app.toggleChatDictation();
    app.cancelChatDictation();
    pendingUserMedia.resolve(stream);
    await start;

    expect(MockMediaRecorder.instances).toHaveLength(0);
    expect(stream.track.stop).toHaveBeenCalledTimes(1);
    expect(app.chatDictationStatus).toBe("idle");
    expect(transcribeChatAudioMock).not.toHaveBeenCalled();
  });
});
