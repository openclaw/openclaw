import { flush } from "solid-js";
/* @vitest-environment jsdom */
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { registerComposerEditor } from "../../lib/composer-input.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { DictationFormattingReview } from "./components/composer-dictation-formatting.tsx";
import { DirectDictationView } from "./components/direct-dictation-view.tsx";
import { ComposerDictationSession } from "./composer-dictation-session.ts";
import {
  createClient,
  emit,
  installDictationSessionFixtures,
  request,
  sessionResult,
  transcript,
} from "./composer-dictation.test-support.ts";
import {
  createDirectDictationTextarea,
  DirectDictationControl,
} from "./composer-direct-dictation.ts";

installDictationSessionFixtures();

function fixture(mode: "preserve" | "explicit" = "explicit") {
  const previousMode = loadSettings().dictationFormatting;
  patchSettings({ dictationFormatting: { version: 1, mode } });
  request.mockImplementation(async (method) => {
    if (method === "talk.session.create") {
      return sessionResult();
    }
    if (method === "talk.catalog") {
      return { transcription: { ready: true, providers: [] } };
    }
    return { ok: true };
  });
  const client = createClient();
  const onMessage = vi.fn();
  const onSubmit = vi.fn();
  let target!: HTMLTextAreaElement;
  const adapter = createDirectDictationTextarea(() => target ?? null);
  const control = new DirectDictationControl({
    textarea: adapter,
    getClient: () => client,
    isConnected: () => true,
    canCommit: () => true,
    onMessage,
    onError: vi.fn(),
    onSubmit,
  });
  const view = mountSolid(() => {
    const projected = projectOwner(control, (owner) => owner);
    return (
      <form>
        <textarea
          ref={(element) => (target = element)}
          readonly={projected.read().dictation?.locksComposer}
        />
        <button type="button">Unrelated action</button>
        <DirectDictationView
          control={control}
          ownerKey="draft"
          idleLabel="Dictate"
          renderRevision={{ revision: projected.revision() }}
        />
        <DictationFormattingReview readDictation={() => projected.read().dictation} />
      </form>
    );
  });
  // Real registration/adapter boundary, with a synthetic editor engine. This is
  // DOM regression evidence; jsdom cannot qualify native browser undo or media.
  const unregister = registerComposerEditor(target, {
    element: target,
    focusElement: target,
    scrollElement: target,
    coordsAtPos: () => null,
    sync: vi.fn(),
    requestSync: vi.fn(),
    focus: (options) => target.focus(options),
    select: (start, end) => target.setSelectionRange(start, end),
    replace: vi.fn(),
    replaceAll: (text) => {
      target.value = text;
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    },
    undo: vi.fn(),
  });
  onTestFinished(() => {
    view.unmount();
    control.dispose();
    unregister();
    patchSettings({ dictationFormatting: previousMode });
  });
  return {
    ...view,
    adapter,
    control,
    target,
    onMessage,
    onSubmit,
    async start() {
      await vi.dynamicImportSettled();
      flush();
      const start = vi.spyOn(ComposerDictationSession.prototype, "start");
      const microphone = view.getByRole("button", { name: "Dictate", exact: true });
      microphone.focus();
      microphone.click();
      await vi.dynamicImportSettled();
      const started = start.mock.results[0];
      assert.isDefined(started);
      await started.value;
      flush();
      const owner = control.dictation;
      assert.isDefined(owner);
      expect(owner.active).toBe(true);
      expect(owner.connecting).toBe(false);
      return owner;
    },
    async finalize(finishing: Promise<boolean>) {
      transcript("Shopping list bullet milk next item eggs");
      emit({ type: "close", reason: "completed" });
      await finishing;
      flush();
      expect(onSubmit).not.toHaveBeenCalled();
    },
  };
}

it("retains target focus when the focused Finish control is removed before final transcription", async () => {
  const view = fixture();
  const owner = await view.start();
  const finish = vi.spyOn(owner, "finishActive");
  const button = view.getByRole("button", { name: "Finish and review", exact: true });
  button.focus();
  expect(document.activeElement).toBe(button);
  button.click();
  flush();
  const finishing = finish.mock.results[0];
  assert.isDefined(finishing);
  expect(button.isConnected).toBe(false);
  await view.finalize(finishing.value);
  expect(document.activeElement).toBe(view.target);
  expect(owner.formattingReview?.canApply).toBe(true);
  const plainText = owner.formattingReview?.result.plainText;
  const apply = view.getByRole("button", { name: "Use formatted text", exact: true });
  apply.focus();
  apply.click();
  flush();
  expect(view.target.value).toBe(plainText);
  expect(view.onMessage).toHaveBeenCalledExactlyOnceWith(plainText);
  expect(owner.formattingReceipt).toBe("committed");
  expect(view.onSubmit).not.toHaveBeenCalled();
});

it("does not invalidate Explicit capture while owner preparation precedes the readonly DOM update", async () => {
  const view = fixture();
  const owner = await view.start();
  view.target.focus();
  const idleReadonly: boolean[] = [];
  const stop = view.control.subscribe(() => {
    if (!owner.active) {
      idleReadonly.push(view.target.readOnly);
      view.control.prepare("draft");
    }
  });
  try {
    const finishing = owner.finishActive();
    flush();
    await view.finalize(finishing);
    expect(idleReadonly).not.toContain(true);
    expect(owner.formattingReview?.canApply).toBe(true);
  } finally {
    stop();
  }
});

it.each(["readonly", "disabled", "external focus", "restored edit"] as const)(
  "keeps genuine %s invalidation copy-only across direct completion",
  async (change) => {
    const view = fixture();
    const owner = await view.start();
    expect(view.target.readOnly).toBe(false);
    view.target.focus();
    if (change === "external focus") {
      view.getByRole("button", { name: "Unrelated action" }).focus();
    } else if (change === "restored edit") {
      view.target.value = "A newer draft";
      view.target.dispatchEvent(new InputEvent("input", { bubbles: true }));
      view.target.value = "";
      view.target.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      view.target.readOnly = change === "readonly";
      view.target.disabled = change === "disabled";
      view.control.prepare("draft");
      view.target.readOnly = false;
      view.target.disabled = false;
    }
    const finishing = owner.finishActive();
    flush();
    await view.finalize(finishing);
    if (change === "external focus") {
      expect(document.activeElement).toBe(view.getByRole("button", { name: "Unrelated action" }));
      view.target.focus();
    }
    expect(owner.formattingReview?.canApply).toBe(false);
    expect(owner.formattingReview?.canApplyOriginal).toBe(false);
    expect(owner.acceptFormatting("formatted")).toBe(false);
    expect(view.onMessage).not.toHaveBeenCalled();
  },
);

it("retains Preserve recording locks and its original direct insertion", async () => {
  const view = fixture("preserve");
  const owner = await view.start();
  expect(view.target.readOnly).toBe(true);
  expect(view.control.locksDraft).toBe(true);
  view.target.focus();
  const finishing = owner.finishActive();
  flush();
  expect(view.target.readOnly).toBe(false);
  await view.finalize(finishing);
  expect(owner.formattingReview).toBeUndefined();
  expect(view.onMessage).toHaveBeenCalledExactlyOnceWith(
    "Shopping list bullet milk next item eggs",
  );
});
