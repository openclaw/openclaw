/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { restoreMocksAndGlobals } from "../../../test-helpers/mock-cleanup.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createContext,
  createRuntimeConfigStub,
} from "../../skill-workshop/skill-workshop-page.test-support.ts";
import { ReadAloud } from "./chat-read-aloud.tsx";

registerChatMessageMetadataEnglish();

afterEach(() => restoreMocksAndGlobals());

it("retains downloaded speech through a blip but retires it when the client changes", async () => {
  const started = createDeferred();
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic-speech");
  vi.stubGlobal("Audio", function (src: string) {
    const element = document.createElement("audio");
    Object.defineProperty(element, "src", { value: src, writable: true });
    element.play = () => {
      if (element.src.startsWith("blob:")) {
        started.resolve();
      }
      return Promise.resolve();
    };
    element.pause = () => undefined;
    element.load = () => undefined;
    return element;
  });
  const request = vi.fn<() => Promise<unknown>>().mockResolvedValue({
    audioBase64: "UklGRg==",
    mimeType: "audio/wav",
    provider: "openai",
  });
  const runtimeConfig = createRuntimeConfigStub();
  Object.assign(runtimeConfig.state, {
    configSnapshot: { runtimeConfig: { tts: { provider: "openai" } } },
  });
  const context = createContext(request, { methods: ["tts.speak"], runtimeConfig });
  const listeners = new Set<() => void>();
  context.gateway.subscribe = (listener) => {
    const notify = () => listener(context.gateway.snapshot);
    listeners.add(notify);
    return () => listeners.delete(notify);
  };
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
    flush();
  };
  const provider = createSolidApplicationContextProvider(context);
  const view = mountSolid(() => <ReadAloud text="Local voice is working." />, {
    wrapper: provider.wrapper,
  });
  const snapshot = context.gateway.snapshot;
  const hello = snapshot.hello;
  view.getByRole<HTMLButtonElement>("button", { name: "Read aloud" }).click();
  await started.promise;
  flush();
  const stop = view.getByRole<HTMLButtonElement>("button", { name: "Stop reading" });

  snapshot.phase = "reconnecting";
  snapshot.hello = null;
  notify();
  expect(revoke).not.toHaveBeenCalled();
  expect(view.getByRole("button", { name: "Stop reading" })).toBe(stop);

  snapshot.phase = "connected";
  snapshot.hello = hello;
  notify();
  expect(revoke).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledOnce();

  snapshot.client = createContext(vi.fn()).gateway.snapshot.client;
  notify();
  expect(revoke).toHaveBeenCalledWith("blob:synthetic-speech");
  await waitForSolid(() => expect(view.getByRole("button", { name: "Read aloud" })).toBe(stop));
});
