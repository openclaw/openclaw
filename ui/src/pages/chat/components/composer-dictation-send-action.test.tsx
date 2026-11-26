/* @vitest-environment jsdom */
import { createRoot } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.ts";
import { cleanupSolid } from "../../../test-helpers/mount-solid.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { ComposerDictationOwner } from "../composer-dictation.ts";
import { ComposerDictationSendAction } from "./chat-composer-controls.tsx";
import {
  getChatComposerState,
  markComposerInputIntent,
  resetChatComposerState,
} from "./chat-composer-state.ts";

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

// The callback is the publication boundary; capture and real media have separate owner proof.
it.each([
  { accepted: true, retired: "none", sends: 1 },
  { accepted: false, retired: "none", sends: 0 },
  { accepted: true, retired: "draft", sends: 0 },
  { accepted: true, retired: "disposed", sends: 0 },
  { accepted: true, retired: "intent", sends: 0 },
])(
  "sends only to the initiating live target after acceptance: $accepted / $retired",
  async ({ accepted, retired, sends }) => {
    let draftKey = "first-draft";
    const owner = new ComposerDictationOwner({
      client: null,
      connected: false,
      enabled: false,
      realtimeTalkActive: false,
      readDraftKey: () => draftKey,
      onCommit: () => false,
      onError: () => {},
    });
    vi.spyOn(owner, "active", "get").mockReturnValue(true);
    const finish = createDeferred<boolean>();
    vi.spyOn(owner, "finishActive").mockReturnValue(finish.promise);
    const firstSend = vi.fn();
    const laterSend = vi.fn();
    const view = mountSolid(ComposerDictationSendAction, {
      readDictation: () => owner,
      onSend: firstSend,
    });
    onTestFinished(() => owner.dispose());
    view.container.querySelector<HTMLButtonElement>("button")!.click();
    view.update({ readDictation: () => owner, onSend: laterSend });
    if (retired === "draft") {
      draftKey = "other-draft";
    }
    if (retired === "disposed") {
      owner.dispose();
    }
    if (retired === "intent") {
      createRoot((dispose) => {
        const paneId = "writing-profile-send-intent";
        const state = getChatComposerState(paneId);
        state.dictation = owner;
        onTestFinished(() => {
          resetChatComposerState(paneId);
          dispose();
        });
        markComposerInputIntent(state, draftKey);
      });
    }
    finish.resolve(accepted);
    await Promise.resolve();
    expect(firstSend).toHaveBeenCalledTimes(sends);
    expect(laterSend).not.toHaveBeenCalled();
  },
);
