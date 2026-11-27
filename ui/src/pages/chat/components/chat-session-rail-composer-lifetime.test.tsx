/* @vitest-environment jsdom */

import { createRoot, onSettled } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSettings, patchSettings } from "../../../app/settings.ts";
import { t } from "../../../i18n/index.ts";
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
    { via: "Enter", mode: "off", cancel: false, resolution: "empty" },
    { via: "Enter", mode: "automatic", cancel: false, resolution: "insert" },
    { via: "form", mode: "automatic", cancel: false, resolution: "original" },
    { via: "form", mode: "automatic", cancel: true, resolution: "discard" },
    { via: "Enter", mode: "automatic", cancel: false, resolution: "dismiss" },
    { via: "Enter", mode: "automatic", cancel: false, resolution: "empty" },
  ])(
    "keeps the $mode submission decision for $via through $resolution",
    async ({ via, mode, cancel, resolution }) => {
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
      const view = mountSolid(() => (
        <SessionRailComposer
          {...props}
          onDraftChange={(value) => {
            props.companion.draft = value;
          }}
        />
      ));
      try {
        await waitForSolid(() =>
          expect(prepare.mock.results.at(-1)?.value.voice.microphonePicker.dictationStatus).toBe(
            "ready",
          ),
        );
        const textarea = view.container.querySelector("textarea")!;
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
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
        const send = () => view.container.querySelector<HTMLButtonElement>('button[type="submit"]');
        const expectSubmissionBlocked = async () => {
          await waitForSolid(() => expect(send()?.disabled).toBe(true));
          textarea.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
          );
          view.container
            .querySelector("form")!
            .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          send()!.click();
          expect(props.submit).not.toHaveBeenCalled();
          expect(finish).toHaveBeenCalledOnce();
        };
        if (mode !== "off") {
          await expectSubmissionBlocked();
        }
        if (cancel) {
          // Retire the capture while finish is pending: its original review decision still applies.
          document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
          );
        } else {
          if (resolution !== "empty") {
            transcript("dictated follow-up");
          }
          emit({ type: "close", reason: "completed" });
        }
        await expect(finish.mock.results[0]!.value).resolves.toBe(false);
        await vi.dynamicImportSettled();
        await waitForSolid(() => expect(textarea.readOnly).toBe(false));
        expect(props.submit).toHaveBeenCalledTimes(mode === "off" ? 1 : 0);
        expect(textarea.value).toBe("A follow-up");
        if (mode !== "off" && !cancel && resolution !== "empty") {
          await waitForSolid(() =>
            expect(
              view.container.querySelector<HTMLTextAreaElement>(".dictation-review textarea")
                ?.value,
            ).toBe("dictated follow-up"),
          );
          await expectSubmissionBlocked();
          if (resolution === "original") {
            view.getByRole("button", { name: t("chat.dictation.punctuation.useOriginal") }).click();
            await expectSubmissionBlocked();
          }
          view
            .getByRole("button", {
              name: t(
                resolution === "dismiss"
                  ? "chat.dictation.punctuation.dismiss"
                  : "chat.dictation.punctuation.insert",
              ),
            })
            .click();
          if (resolution !== "dismiss") {
            const expected =
              resolution === "original"
                ? "A follow-up dictated follow-up"
                : "A follow-up dictated follow-up.";
            await waitForSolid(() => expect(textarea.value).toBe(expected));
            expect(props.companion.draft).toBe(expected);
          }
        }
        if (mode !== "off") {
          await waitForSolid(() => expect(send()?.disabled).toBe(false));
          expect(props.submit).not.toHaveBeenCalled();
          send()!.click();
          expect(props.submit).toHaveBeenCalledOnce();
        }
      } finally {
        view.unmount();
        patchSettings({ dictationRefinement: previous });
      }
    },
  );

  it.each(["Enter", "button"])(
    "does not resume an Off %s submission into a newer enabled capture",
    async (via) => {
      const { props, request } = fixture();
      props.client = createClient();
      let created = 0;
      dictationIo.request.mockImplementation(async (method) =>
        method === "talk.session.create"
          ? sessionResult(`dictation-${++created}`)
          : request(method),
      );
      const previous = loadSettings().dictationRefinement;
      patchSettings({ dictationRefinement: undefined });
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
        await start.mock.results[0]!.value;
        await waitForSolid(() => expect(textarea.readOnly).toBe(true));
        expect(prepare.mock.results.at(-1)?.value.voice.readDictation().requiresReview).toBe(false);
        if (via === "Enter") {
          textarea.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
          );
        } else {
          view.container
            .querySelector<HTMLButtonElement>(".chat-send-btn--dictation-commit")!
            .click();
        }
        expect(finish).toHaveBeenCalledOnce();
        await waitForSolid(() => expect(textarea.readOnly).toBe(false));
        patchSettings({
          dictationRefinement: {
            version: 1,
            mode: "automatic",
            locale: "en-US",
            explicitEnabled: false,
          },
        });
        const previousPreparation = prepare.mock.calls.length;
        window.dispatchEvent(new Event("focus"));
        await waitForSolid(() =>
          expect(prepare.mock.calls.length).toBeGreaterThan(previousPreparation),
        );
        view.container.querySelector<HTMLButtonElement>(".chat-send-btn--voice")!.click();
        await vi.dynamicImportSettled();
        expect(start).toHaveBeenCalledTimes(2);
        await start.mock.results[1]!.value;
        await waitForSolid(() => expect(textarea.readOnly).toBe(true));
        expect(prepare.mock.results.at(-1)?.value.voice.readDictation()).toMatchObject({
          requiresReview: true,
          pendingReview: true,
        });
        await expect(finish.mock.results[0]!.value).resolves.toBe(false);
        expect(props.submit).not.toHaveBeenCalled();
        expect(props.companion.draft).toBe("A follow-up");
      } finally {
        view.unmount();
        patchSettings({ dictationRefinement: previous });
      }
    },
  );
});
