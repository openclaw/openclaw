/* @vitest-environment jsdom */

import type { TtsSpeakResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createContext,
  createRuntimeConfigStub,
} from "../../skill-workshop/skill-workshop-page.test-support.ts";
import { createTestTranscript, renderChatInto, renderChatView } from "../chat-view.test-helpers.ts";
import {
  MessageActions,
  prepareChatMessageRender,
  resolveMessageActionDetails,
} from "./chat-message-markdown-view.tsx";
import { installTranscriptDomMocks } from "./chat-transcript.test-support.ts";

const speech: TtsSpeakResult = {
  audioBase64: "UklGRg==",
  mimeType: "audio/wav",
  provider: "openai",
};
const speechText = "Local voice is working.";
const audio: HTMLAudioElement[] = [];
const play = vi.fn<HTMLAudioElement["play"]>(async () => undefined);
const pause = vi.fn();
const revoke = vi.fn();
const createUrl = vi.fn<(blob: Blob | MediaSource) => string>(() => "blob:synthetic-speech");
let pending: ReturnType<typeof createDeferred<TtsSpeakResult>>;
const request = vi.fn<() => Promise<TtsSpeakResult>>();
let runtimeConfig: ReturnType<typeof createRuntimeConfigStub>;
let context: ReturnType<typeof createContext>;
let gatewayListeners: Set<() => void>;

beforeEach(() => {
  pending = createDeferred<TtsSpeakResult>();
  request.mockReset().mockImplementation(() => pending.promise);
  runtimeConfig = createRuntimeConfigStub();
  Object.assign(runtimeConfig.state, {
    configSnapshot: { runtimeConfig: { tts: { provider: "openai" } } },
  });
  context = createContext(request, { methods: ["tts.speak"], runtimeConfig });
  gatewayListeners = new Set();
  context.gateway.subscribe = (listener) => {
    const notify = () => listener(context.gateway.snapshot);
    gatewayListeners.add(notify);
    return () => gatewayListeners.delete(notify);
  };
  audio.length = 0;
  play.mockReset().mockResolvedValue(undefined);
  [pause, revoke, createUrl].forEach((mock) => mock.mockClear());
  vi.stubGlobal("Audio", function (src: string) {
    const element = document.createElement("audio");
    // Completion is driven by test events, not the browser decoding synthetic WAV bytes.
    Object.defineProperty(element, "src", { value: src, writable: true });
    element.play = play;
    element.pause = pause;
    element.load = () => undefined;
    audio.push(element);
    return element;
  });
  vi.spyOn(URL, "createObjectURL").mockImplementation(createUrl);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function readButton(view: ReturnType<typeof mount>, name = "Read aloud") {
  return view.getByRole<HTMLButtonElement>("button", { name });
}
function mount() {
  const details = resolveMessageActionDetails(
    prepareChatMessageRender({ role: "assistant", content: speechText }),
    { messageId: "reply-1", senderLabel: "OpenClaw" },
  );
  return mountSolid(() => <MessageActions details={details} options={{}} />, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
}

it.each([false, true])(
  "unlocks and reuses audio with Gateway notifications: %s",
  async (notify) => {
    let userActivation = true;
    const permitted = new WeakSet<HTMLAudioElement>();
    play.mockImplementation(function (this: HTMLAudioElement) {
      if (userActivation) {
        permitted.add(this);
      }
      return permitted.has(this)
        ? Promise.resolve()
        : Promise.reject(new DOMException("User activation required", "NotAllowedError"));
    });
    const view = mount();
    const button = readButton(view);
    button.click();
    userActivation = false;
    expect(play).toHaveBeenCalledOnce();
    expect(audio).toHaveLength(1);
    expect(audio[0]?.src).toMatch(/^data:audio\/wav/);
    if (notify) {
      gatewayListeners.forEach((listener) => listener());
      flush();
    }
    pending.resolve(speech);
    await waitForSolid(() => expect(play).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenCalledWith("tts.speak", { text: speechText });
    expect(createUrl.mock.calls[0]?.[0]).toMatchObject({ type: "audio/wav", size: 4 });
    expect(audio[0]?.src).toBe("blob:synthetic-speech");
    if (notify) {
      gatewayListeners.forEach((listener) => listener());
      flush();
    }
    expect(revoke).not.toHaveBeenCalled();
    readButton(view, "Stop reading").click();
    flush();
    expect(pause).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith("blob:synthetic-speech");
    await waitForSolid(() => expect(readButton(view)).toBe(button));
  },
);

it("keeps native transcript speech with its current application context", async () => {
  installTranscriptDomMocks();
  request.mockResolvedValue(speech);
  const transcript = createTestTranscript();
  const props = {
    applicationContext: context,
    transcript,
    messages: [{ role: "assistant", content: speechText }],
  };
  const container = renderChatView(props);
  const action = (name: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  const thread = container.querySelector(".chat-thread-inner");
  const button = action("Read aloud")!;
  button.click();
  await waitForSolid(() => expect(audio[0]?.src).toBe("blob:synthetic-speech"));
  expect(play).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledWith("tts.speak", { text: speechText });
  renderChatInto(container, props);
  expect(action("Stop reading")).toBe(button);
  expect(revoke).not.toHaveBeenCalled();
  const replacementRequest = vi.fn(async () => speech);
  renderChatInto(container, {
    ...props,
    applicationContext: createContext(replacementRequest, {
      methods: ["tts.speak"],
      runtimeConfig,
    }),
  });
  expect(container.querySelector(".chat-thread-inner")).toBe(thread);
  expect(revoke).toHaveBeenCalledWith("blob:synthetic-speech");
  action("Read aloud")!.click();
  await waitForSolid(() => expect(replacementRequest).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledOnce();
  transcript.dispose();
  cleanupSolid();
  // Retained transcript roots retire after the pane disconnection microtask.
  await Promise.resolve();
  flush();
  expect(revoke).toHaveBeenCalledWith("blob:synthetic-speech");
  expect(action("Stop reading")).toBeNull();
});

it("leaves unconfigured speech controls absent", () => {
  Object.assign(runtimeConfig.state, { configSnapshot: { runtimeConfig: {} } });
  const view = mount();
  expect(view.queryByRole("button", { name: "Read aloud" })).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it.each([
  { name: "configured", bootstrapConfig: { tts: {} }, loaded: false, visible: true },
  { name: "unconfigured", bootstrapConfig: { tts: null }, loaded: false, visible: false },
  { name: "older projection", bootstrapConfig: {}, loaded: true, visible: true },
  { name: "no projection", bootstrapConfig: null, loaded: true, visible: true },
  {
    name: "config-only response with older projection",
    bootstrapConfig: {},
    loaded: true,
    visible: true,
    configOnly: true,
  },
  {
    name: "config-only response without projection",
    bootstrapConfig: null,
    loaded: true,
    visible: true,
    configOnly: true,
  },
])("uses $name speech configuration without eagerly loading an editor", async (scenario) => {
  const listeners = new Set<() => void>();
  vi.spyOn(context.runtimeConfig, "subscribe").mockImplementation((listener) => {
    const notify = () => listener(context.runtimeConfig.state);
    listeners.add(notify);
    return () => listeners.delete(notify);
  });
  Object.assign(runtimeConfig.state, {
    configSnapshot: null,
    bootstrapConfig: scenario.bootstrapConfig,
  });
  runtimeConfig.ensureDisplayLoaded.mockImplementation(async () => {
    const config = { tts: {} };
    Object.assign(runtimeConfig.state, {
      configSnapshot: scenario.configOnly ? { config } : { runtimeConfig: config },
    });
    listeners.forEach((notify) => notify());
  });
  const view = mount();
  await waitForSolid(() => {
    expect(Boolean(view.queryByRole("button", { name: "Read aloud" }))).toBe(scenario.visible);
  });
  expect(runtimeConfig.ensureDisplayLoaded).toHaveBeenCalledTimes(scenario.loaded ? 1 : 0);
});

it.each(["bootstrap", "config-only"])(
  "chunks speech using the %s limit without reading the full config",
  async (source) => {
    const config = { tts: { maxTextLength: 12 } };
    Object.assign(runtimeConfig.state, {
      configSnapshot: source === "config-only" ? { config } : null,
      bootstrapConfig: source === "bootstrap" ? config : {},
    });
    request.mockResolvedValue(speech);
    const view = mount();
    readButton(view).click();
    await waitForSolid(() => expect(audio[0]?.src).toBe("blob:synthetic-speech"));
    expect(request).toHaveBeenNthCalledWith(1, "tts.speak", { text: "Local voice" });
    audio[0]!.dispatchEvent(new Event("ended"));
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenNthCalledWith(2, "tts.speak", { text: "is working." });
    expect(runtimeConfig.ensureDisplayLoaded).not.toHaveBeenCalled();
  },
);

it("does not play a synthesis result after the message is unmounted", async () => {
  const view = mount();
  readButton(view).click();
  view.unmount();
  pending.resolve(speech);
  await pending.promise;
  await Promise.resolve();
  expect(createUrl).not.toHaveBeenCalled();
  expect(play).toHaveBeenCalledOnce();
});

it("shows a Gateway synthesis failure instead of starting another speech provider", async () => {
  const retry = createDeferred<TtsSpeakResult>();
  request
    .mockRejectedValueOnce(new Error("Local speech endpoint unavailable"))
    .mockReturnValueOnce(retry.promise);
  const view = mount();
  const button = readButton(view);
  button.click();
  await waitForSolid(() =>
    expect(view.getByRole("status").textContent).toContain("Local speech endpoint unavailable"),
  );
  expect(request).toHaveBeenCalledOnce();
  expect(play).toHaveBeenCalledOnce();
  expect(readButton(view)).toBe(button);
  button.click();
  await waitForSolid(() => expect(readButton(view, "Stop reading")).toBe(button));
  expect(view.queryByRole("status")).toBeNull();
  expect(createUrl).not.toHaveBeenCalled();
  retry.resolve(speech);
  await waitForSolid(() => expect(audio[0]?.src).toBe("blob:synthetic-speech"));
  expect(view.queryByRole("status")).toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
});

it("stops same-tick playback and ignores its late synthesis during a new playback", async () => {
  const view = mount();
  const button = readButton(view);
  button.click();
  button.click();
  expect(request).toHaveBeenCalledOnce();
  await waitForSolid(() => expect(readButton(view)).toBe(button));

  const next = createDeferred<TtsSpeakResult>();
  request.mockReturnValueOnce(next.promise);
  button.click();
  await waitForSolid(() => expect(readButton(view, "Stop reading")).toBe(button));
  pending.resolve(speech);
  await pending.promise;
  await Promise.resolve();
  expect(createUrl).not.toHaveBeenCalled();
  expect(readButton(view, "Stop reading")).toBe(button);
  next.resolve(speech);
  await waitForSolid(() => expect(audio[0]?.src).toBe("blob:synthetic-speech"));
  expect(request).toHaveBeenCalledTimes(2);
});
