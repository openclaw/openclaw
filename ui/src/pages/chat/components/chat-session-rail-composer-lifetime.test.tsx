/* @vitest-environment jsdom */

import { createRoot, onSettled } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSettings, patchSettings } from "../../../app/settings.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ComposerDictationSession } from "../composer-dictation-session.ts";
import {
  createClient,
  dictationIo,
  emit,
  sessionResult,
  setupDictationFixtures,
  transcript,
} from "../composer-dictation.test-support.ts";
import { ComposerDictationOwner } from "../composer-dictation.ts";
import { DirectDictationControl } from "../composer-direct-dictation.ts";
import { SessionRailComposer } from "./chat-session-rail-composer.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fixture() {
  const observations = new Map<Element, () => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect = vi.fn();
      observe = (element: Element) => observations.set(element, this.disconnect);
      unobserve() {}
    },
  );
  const request = vi.fn(async (method: string) =>
    method === "talk.catalog" ? { transcription: { ready: true }, realtime: { ready: true } } : {},
  );
  const props = {
    sessionKey: "agent:test:main",
    client: createTestGatewayClient(request),
    presented: true,
    textareaRef: () => {},
    companion: { draft: "A follow-up", turns: [], loading: false },
    connected: true,
    pending: false,
    sendShortcut: "enter",
    attachmentProps: {},
    submit: vi.fn(),
  } satisfies Parameters<typeof SessionRailComposer>[0];
  return { props, request, observations };
}

it("does not acquire textarea or dictation resources before the rail settles", () => {
  const { props, request, observations } = fixture();
  let settled = false;
  const view = mountSolid(() => {
    createRoot((dispose) => {
      onSettled(() => {
        settled = true;
      });
      const content = <SessionRailComposer {...props} />;
      dispose();
      return content;
    });
    return null;
  });
  try {
    expect(settled).toBe(false);
    expect({
      requests: request.mock.calls.length,
      textareaObservers: [...observations.keys()].filter(
        (element) => element.tagName === "TEXTAREA",
      ).length,
    }).toEqual({ requests: 0, textareaObservers: 0 });
  } finally {
    view.unmount();
  }
});

it("observes the mounted textarea and retires dictation focus refresh with the rail", async () => {
  const { props, request, observations } = fixture();
  const view = mountSolid(() => <SessionRailComposer {...props} />);
  try {
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    const textarea = view.container.querySelector("textarea")!;
    const disconnect = observations.get(textarea);
    expect(disconnect).toBeDefined();
    expect(view.container.querySelector(".chat-send-btn--voice")).not.toBeNull();
    window.dispatchEvent(new Event("focus"));
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(4));
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("focus"));
    expect(request).toHaveBeenCalledTimes(4);
  } finally {
    view.unmount();
  }
});

describe("dictation submission", () => {
  setupDictationFixtures();

  it.each([
    { via: "Enter", mode: "off", cancel: false },
    { via: "Enter", mode: "automatic", cancel: false },
    { via: "form", mode: "automatic", cancel: false },
    { via: "form", mode: "automatic", cancel: true },
  ])(
    "keeps the $mode submission decision for $via (cancel=$cancel)",
    async ({ via, mode, cancel }) => {
      const { props, request } = fixture();
      props.client = createClient();
      dictationIo.request.mockImplementation(async (method) =>
        method === "talk.session.create" ? sessionResult() : request(method),
      );
      const previous = loadSettings().dictationRefinement;
      patchSettings({
        dictationRefinement:
          mode === "off"
            ? undefined
            : { version: 1, mode: "automatic", locale: "en-US", explicitEnabled: false },
      });
      const start = vi.spyOn(ComposerDictationSession.prototype, "start");
      const finish = vi.spyOn(ComposerDictationOwner.prototype, "finishActive");
      const prepare = vi.spyOn(DirectDictationControl.prototype, "prepare");
      const view = mountSolid(() => <SessionRailComposer {...props} />);
      try {
        await waitForSolid(() =>
          expect(prepare.mock.results.at(-1)?.value.voice.microphonePicker.dictationStatus).toBe(
            "ready",
          ),
        );
        const textarea = view.container.querySelector("textarea")!;
        view.container.querySelector<HTMLButtonElement>(".chat-send-btn--voice")!.click();
        await vi.dynamicImportSettled();
        expect(start).toHaveBeenCalledOnce();
        await start.mock.results[0]!.value;
        await waitForSolid(() => expect(textarea.readOnly).toBe(true));

        if (via === "Enter") {
          textarea.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
          );
        } else {
          view.container
            .querySelector("form")!
            .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        }
        expect(finish).toHaveBeenCalledOnce();
        expect(props.submit).not.toHaveBeenCalled();
        if (cancel) {
          // Retire the capture while finish is pending: its original review decision still applies.
          document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
          );
        } else {
          if (mode !== "off") {
            transcript("dictated follow-up");
          }
          emit({ type: "close", reason: "completed" });
        }
        await expect(finish.mock.results[0]!.value).resolves.toBe(false);
        await vi.dynamicImportSettled();
        await waitForSolid(() => expect(textarea.readOnly).toBe(false));
        expect(props.submit).toHaveBeenCalledTimes(mode === "off" ? 1 : 0);
        expect(textarea.value).toBe("A follow-up");
        if (mode !== "off" && !cancel) {
          await waitForSolid(() =>
            expect(
              view.container.querySelector<HTMLTextAreaElement>(".dictation-review textarea")
                ?.value,
            ).toBe("dictated follow-up"),
          );
        }
      } finally {
        view.unmount();
        patchSettings({ dictationRefinement: previous });
      }
    },
  );
});
