/* @vitest-environment jsdom */

import type { TtsSpeakResult } from "@openclaw/gateway-protocol";
import { expectDefined } from "@openclaw/normalization-core/expect";
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

const audio: HTMLAudioElement[] = [];
const play = vi.fn<HTMLAudioElement["play"]>(async () => undefined);
const pause = vi.fn();
const revoke = vi.fn();
const createUrl = vi.fn<(blob: Blob | MediaSource) => string>(() => "blob:synthetic-speech");

beforeEach(() => {
  audio.length = 0;
  play.mockReset().mockResolvedValue(undefined);
  pause.mockClear();
  revoke.mockClear();
  createUrl.mockClear();
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

function mount(
  request: ReturnType<typeof vi.fn>,
  configured = true,
  gatewayListeners?: Set<() => void>,
) {
  const runtimeConfig = createRuntimeConfigStub();
  Object.assign(runtimeConfig.state, {
    configSnapshot: { runtimeConfig: configured ? { tts: { provider: "openai" } } : {} },
  });
  const context = createContext(request, { methods: ["tts.speak"], runtimeConfig });
  if (gatewayListeners) {
    context.gateway.subscribe = (listener) => {
      const notify = () => listener(context.gateway.snapshot);
      gatewayListeners.add(notify);
      return () => gatewayListeners.delete(notify);
    };
  }
  const provider = createSolidApplicationContextProvider(context);
  const details = resolveMessageActionDetails(
    prepareChatMessageRender({ role: "assistant", content: "Local voice is working." }),
    { messageId: "reply-1", senderLabel: "OpenClaw" },
  );
  return mountSolid(() => <MessageActions details={details} options={{}} />, {
    wrapper: provider.wrapper,
  });
}

it("unlocks and reuses the same audio element before awaiting Gateway speech", async () => {
  const pending = createDeferred<TtsSpeakResult>();
  const request = vi.fn(() => pending.promise);
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
  const view = mount(request);
  const button = view.getByRole<HTMLButtonElement>("button", { name: "Read aloud" });
  button.click();
  userActivation = false;
  expect(play).toHaveBeenCalledOnce();
  expect(audio).toHaveLength(1);
  expect(audio[0]?.src).toMatch(/^data:audio\/wav/);
  pending.resolve({ audioBase64: "UklGRg==", mimeType: "audio/wav", provider: "openai" });
  await waitForSolid(() => expect(play).toHaveBeenCalledTimes(2));
  expect(request).toHaveBeenCalledWith("tts.speak", { text: "Local voice is working." });
  expect(createUrl.mock.calls[0]?.[0]).toMatchObject({ type: "audio/wav", size: 4 });
  expect(audio[0]?.src).toBe("blob:synthetic-speech");
  view.getByRole<HTMLButtonElement>("button", { name: "Stop reading" }).click();
  flush();
  expect(pause).toHaveBeenCalledTimes(2);
  expect(revoke).toHaveBeenCalledWith("blob:synthetic-speech");
  expect(view.getByRole("button", { name: "Read aloud" })).toBe(button);
});

it("keeps speech through Gateway notifications that preserve connection and text", async () => {
  const pending = createDeferred<TtsSpeakResult>();
  const gatewayListeners = new Set<() => void>();
  const view = mount(
    vi.fn(() => pending.promise),
    true,
    gatewayListeners,
  );
  view.getByRole<HTMLButtonElement>("button", { name: "Read aloud" }).click();
  for (const notify of gatewayListeners) {
    notify();
  }
  flush();
  pending.resolve({ audioBase64: "UklGRg==", mimeType: "audio/wav", provider: "openai" });
  await waitForSolid(() => expect(play).toHaveBeenCalledTimes(2));
  for (const notify of gatewayListeners) {
    notify();
  }
  flush();
  expect(revoke).not.toHaveBeenCalled();
  view.getByRole<HTMLButtonElement>("button", { name: "Stop reading" }).click();
  flush();
  expect(revoke).toHaveBeenCalledWith("blob:synthetic-speech");
});

it("keeps native transcript speech with its current application context", async () => {
  installTranscriptDomMocks();
  const speechStarted = createDeferred();
  play.mockImplementation(async function (this: HTMLAudioElement) {
    if (this.src.startsWith("blob:")) {
      speechStarted.resolve();
    }
  });
  const synthesize = async () => ({
    audioBase64: "UklGRg==",
    mimeType: "audio/wav",
    provider: "openai",
  });
  const request = vi.fn(synthesize);
  const stub = createRuntimeConfigStub();
  const runtimeConfig = {
    ...stub,
    state: {
      ...stub.state,
      configSnapshot: {
        hash: "synthetic",
        sourceConfig: {},
        runtimeConfig: { tts: { provider: "openai" } },
      },
    },
  };
  const context = createContext(request, { methods: ["tts.speak"], runtimeConfig });
  const transcript = createTestTranscript();
  const messages = [{ role: "assistant", content: "Local voice is working." }];
  const props = {
    applicationContext: context,
    transcript,
    messages,
  };
  const container = renderChatView(props);
  const thread = container.querySelector(".chat-thread-inner");
  const button = expectDefined(
    container.querySelector<HTMLButtonElement>('[aria-label="Read aloud"]'),
    "configured Read aloud action in the native transcript",
  );
  button.click();
  await speechStarted.promise;
  expect(play).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledWith("tts.speak", { text: "Local voice is working." });
  renderChatInto(container, props);
  expect(container.querySelector('[aria-label="Stop reading"]')).toBe(button);
  expect(revoke).not.toHaveBeenCalled();

  const replacementRequest = vi.fn(synthesize);
  renderChatInto(container, {
    ...props,
    applicationContext: createContext(replacementRequest, {
      methods: ["tts.speak"],
      runtimeConfig,
    }),
  });
  expect(container.querySelector(".chat-thread-inner")).toBe(thread);
  expect(revoke).toHaveBeenCalledWith("blob:synthetic-speech");
  expectDefined(
    container.querySelector<HTMLButtonElement>('[aria-label="Read aloud"]'),
    "Read aloud action for the replacement application",
  ).click();
  await waitForSolid(() => expect(replacementRequest).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledOnce();
  transcript.hostDisconnected();
  cleanupSolid();
  // Retained transcript roots retire after the pane disconnection microtask.
  await Promise.resolve();
  flush();
  expect(revoke).toHaveBeenCalledWith("blob:synthetic-speech");
  expect(container.querySelector('[aria-label="Stop reading"]')).toBeNull();
});

it("leaves unconfigured speech controls absent", () => {
  const request = vi.fn();
  const view = mount(request, false);
  expect(view.queryByRole("button", { name: "Read aloud" })).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it("does not play a synthesis result after the message is unmounted", async () => {
  const pending = createDeferred<TtsSpeakResult>();
  const view = mount(vi.fn(() => pending.promise));
  view.getByRole<HTMLButtonElement>("button", { name: "Read aloud" }).click();
  view.unmount();
  pending.resolve({ audioBase64: "UklGRg==", mimeType: "audio/wav", provider: "openai" });
  await pending.promise;
  await Promise.resolve();
  expect(createUrl).not.toHaveBeenCalled();
  expect(play).toHaveBeenCalledOnce();
});

it("shows a Gateway synthesis failure instead of starting another speech provider", async () => {
  const request = vi.fn(async () => {
    throw new Error("Local speech endpoint unavailable");
  });
  const view = mount(request);
  view.getByRole<HTMLButtonElement>("button", { name: "Read aloud" }).click();
  await waitForSolid(() =>
    expect(view.getByRole("status").textContent).toContain("Local speech endpoint unavailable"),
  );
  expect(request).toHaveBeenCalledOnce();
  expect(play).toHaveBeenCalledOnce();
});
