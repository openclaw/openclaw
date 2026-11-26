// @vitest-environment jsdom
import { createComponent } from "solid-js";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createComposerProps } from "./chat-composer.test-support.ts";
import { createComposerDictationOptions } from "./components/chat-composer-dictation-options.ts";
import {
  commitComposerDraft,
  getChatComposerState,
  resetChatComposerState,
} from "./components/chat-composer-state.ts";
import { ComposerDictationStatus } from "./components/chat-voice-activity.tsx";
import {
  controllerFixture,
  dictationIo,
  emit,
  refinementTextareas,
  sessionResult,
  setupDictationFixtures,
  startDirect,
  transcript,
  type ControllerOptions,
} from "./composer-dictation.test-support.ts";
import type { ComposerDictationOwner } from "./composer-dictation.ts";
import { createDirectDictationTextarea } from "./composer-direct-dictation.ts";
import { ComposerMicrophoneOwner } from "./composer-microphone-picker.ts";

setupDictationFixtures();

function refinementHarness(overrides: Omit<Partial<ControllerOptions>, "client"> = {}) {
  const target = document.createElement("textarea");
  document.body.append(target);
  let currentTarget = target;
  const textarea = createDirectDictationTextarea(() => currentTarget);
  refinementTextareas.push(textarea);
  const write: ControllerOptions["onCommit"] = (text, late, preservePreview, reviewed) => {
    const result = textarea.insertTranscript(
      (...args) => controller.placeTranscript(...args),
      text,
      late,
      preservePreview,
      reviewed,
    );
    return typeof result === "string" ? true : (result ?? false);
  };
  const commit = vi.fn(write);
  const harness = controllerFixture({
    refinement: { policy: { mode: "automatic", locale: "en-US", explicitEnabled: false } },
    readRefinementTarget: () => textarea.readTarget(),
    onCommit: commit,
    ...overrides,
  });
  const controller: ComposerDictationOwner = harness.controller;
  return {
    ...harness,
    target,
    textarea,
    commit,
    write,
    async start() {
      textarea.captureSelection();
      await startDirect(controller);
    },
    async finish(text: string, id = "dictation-1") {
      const finished = controller.finishActive();
      transcript(text, id);
      emit({ transcriptionSessionId: id, type: "close", reason: "completed" });
      return finished;
    },
    replaceTarget(next: HTMLTextAreaElement) {
      currentTarget = next;
    },
  };
}

describe("opt-in dictation review through the textarea insertion owner", () => {
  it.each(["direct", "chat"])(
    "refuses a stale %s selection before capture can overwrite a newer draft",
    async (kind) => {
      const h = refinementHarness();
      h.target.value = "original A";
      h.target.setSelectionRange(h.target.value.length, h.target.value.length);
      h.textarea.captureSelection();
      let controller = h.controller;
      let changeDraft = (value: string) => {
        h.target.value = value;
        h.target.dispatchEvent(new Event("input"));
      };
      if (kind === "chat") {
        let draft = h.target.value;
        const props = createComposerProps({
          gatewayClient: h.options.client,
          draft,
          getDraft: () => draft,
          onDraftChange: (value) => {
            draft = value;
          },
        });
        const state = getChatComposerState(props.paneId);
        state.composerTextarea = h.target;
        state.dictationSelection = { value: draft, start: draft.length, end: draft.length };
        const picker = new ComposerMicrophoneOwner();
        const options = createComposerDictationOptions(props, state, picker, vi.fn());
        controller = controllerFixture({
          ...options,
          refinement: h.options.refinement,
          dictationAvailable: true,
        }).controller;
        state.dictation = controller;
        changeDraft = (value) => {
          h.target.value = value;
          commitComposerDraft(props, value);
        };
        onTestFinished(() => {
          resetChatComposerState(props.paneId);
          picker.dispose();
        });
      }
      changeDraft("newer B");
      expect(controller.startDirect()).toBe(true);
      await vi.dynamicImportSettled();
      expect(controller.active).toBe(false);
      expect(dictationIo.request).not.toHaveBeenCalledWith(
        "talk.session.create",
        expect.anything(),
      );
      expect(controller.insertReviewed()).toBe(false);
      expect(h.target.value).toBe("newer B");
    },
  );

  it("freezes policy at capture, reviews before writing, and commits only once", async () => {
    const h = refinementHarness();
    await h.start();
    h.controller.update({
      ...h.options,
      refinement: { policy: { mode: "explicit", locale: "fr-FR", explicitEnabled: true } },
    });
    await expect(h.finish("hello world")).resolves.toBe(false);
    expect(h.target.value).toBe("");
    expect(h.controller.review).toMatchObject({
      rawText: "hello world",
      result: { text: "Hello world.", status: "refined", effectiveLocale: "en-US" },
      policy: { mode: "automatic", locale: "en-US" },
      canInsert: true,
      delivery: "not-attempted",
    });
    expect(h.controller.pendingReview).toBe(true);
    expect(h.controller.insertReviewed()).toBe(true);
    expect(h.target.value).toBe("Hello world.");
    expect(h.controller.review?.delivery).toBe("committed");
    expect(h.controller.pendingReview).toBe(false);
    expect(h.controller.insertReviewed()).toBe(false);
    expect(h.controller.chooseOriginal()).toBe(false);
    expect(h.controller.reprocess({ mode: "verbatim", explicitEnabled: false })).toBe(false);
    h.controller.cancel();
    expect(h.controller.review?.delivery).toBe("committed");
    expect(h.commit).toHaveBeenCalledOnce();
  });

  it.each([
    { limit: 8, committed: false },
    { limit: 13, committed: true },
    { limit: undefined, committed: true },
  ])("keeps a reviewed insertion complete at limit $limit", async ({ limit, committed }) => {
    const h = refinementHarness();
    h.target.value = "ask me";
    h.target.setSelectionRange(6, 6);
    if (limit !== undefined) {
      h.target.maxLength = limit;
    }
    await h.start();
    await h.finish("Basil.");
    expect(h.controller.review?.result.text).toBe("Basil.");
    const input = vi.fn();
    h.target.addEventListener("input", input);

    expect(h.controller.insertReviewed()).toBe(committed);
    const expected = committed ? "ask me Basil." : "ask me";
    expect(h.target.value).toBe(expected);
    expect(h.controller.review).toMatchObject({
      rawText: "Basil.",
      result: { text: "Basil." },
      delivery: committed ? "committed" : "not-committed",
      canInsert: false,
      canUndo: committed,
    });
    expect(h.controller.pendingReview).toBe(false);
    expect(h.controller.insertReviewed()).toBe(false);
    expect(h.target.value).toBe(expected);
    expect(input).toHaveBeenCalledTimes(committed ? 1 : 0);
    expect(h.commit).toHaveBeenCalledOnce();
    if (!committed) {
      expect(h.commit.mock.results[0]?.value).toBe(false);
    }
  });

  it("reprocesses unsent text at a newer revision and retires refined output on raw selection", async () => {
    const h = refinementHarness();
    await h.start();
    await h.finish("hello comma world period");
    const firstRevision = h.controller.review?.revision;
    expect(firstRevision).toBe(1);
    expect(
      h.controller.reprocess({ mode: "explicit", locale: "en-US", explicitEnabled: true }),
    ).toBe(true);
    expect(h.controller.review).toMatchObject({ revision: 2, result: { text: "Hello, world." } });
    expect(h.controller.chooseOriginal()).toBe(true);
    expect(h.controller.pendingReview).toBe(true);
    expect(h.controller.review).toMatchObject({
      revision: 3,
      selected: "original",
      result: { text: "hello comma world period", transcriptRevision: 3 },
    });
    transcript("obsolete provider final");
    expect(h.controller.insertReviewed()).toBe(true);
    expect(h.target.value).toBe("hello comma world period");
    expect(h.commit).toHaveBeenCalledOnce();
  });

  it.each(["recording", "finishing"])(
    "keeps recognized raw recovery after manual edits while %s without overwriting them",
    async (phase) => {
      const h = refinementHarness();
      await h.start();
      transcript("keep these recognized words");
      const finished = phase === "finishing" ? h.controller.finishActive() : null;
      h.target.value = "my manual replacement";
      h.target.dispatchEvent(new Event("input"));
      h.controller.update(h.options);
      transcript("late replacement must not appear");
      emit({ type: "close", reason: "completed" });
      if (finished) {
        await expect(finished).resolves.toBe(false);
      }
      expect(h.controller.review).toMatchObject({
        rawText: "keep these recognized words",
        selected: "original",
        limitation: "draft-changed",
        canInsert: false,
      });
      expect(h.controller.insertReviewed()).toBe(false);
      expect(h.target.value).toBe("my manual replacement");
      expect(h.commit).not.toHaveBeenCalled();
      expect(h.controller.pendingReview).toBe(true);
      h.controller.dismissReview();
      expect(h.controller.pendingReview).toBe(false);
    },
  );

  it.each(["empty", "edited"])(
    "releases pending review after a stopped capture is %s without a recoverable result",
    async (ending) => {
      const h = refinementHarness();
      await h.start();
      const finished = h.controller.finishActive();
      expect(h.controller.pendingReview).toBe(true);
      if (ending === "edited") {
        h.target.value = "manual replacement";
        h.target.dispatchEvent(new Event("input"));
        h.controller.update(h.options);
      }
      emit({ type: "close", reason: "completed" });
      await expect(finished).resolves.toBe(false);
      expect(h.controller.review).toBeNull();
      expect(h.controller.pendingReview).toBe(false);
      expect(h.commit).not.toHaveBeenCalled();
    },
  );

  it("releases pending review when Stop precedes session preparation", async () => {
    const preparation = createDeferred<string | undefined>();
    const h = refinementHarness({ prepareSession: () => preparation.promise });
    h.textarea.captureSelection();
    expect(h.controller.startDirect()).toBe(true);
    expect(h.controller.pendingReview).toBe(true);
    await expect(h.controller.finishActive()).resolves.toBe(false);
    expect(h.controller.pendingReview).toBe(false);
    preparation.resolve("prepared-session");
    await vi.dynamicImportSettled();
    expect(h.controller.review).toBeNull();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it.each(["edit", "target"])("does not revive an A → B → A %s during review", async (kind) => {
    const h = refinementHarness();
    await h.start();
    await h.finish("hello world");
    if (kind === "edit") {
      h.target.value = "different";
      h.target.dispatchEvent(new Event("input"));
      h.target.value = "";
      h.target.dispatchEvent(new Event("input"));
    } else {
      h.replaceTarget(document.createElement("textarea"));
      h.controller.update(h.options);
      h.replaceTarget(h.target);
    }
    h.controller.update(h.options);
    expect(h.controller.insertReviewed()).toBe(false);
    expect(h.controller.review?.limitation).toBe("draft-changed");
    expect(h.target.value).toBe("");
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("retires a stopped capture when a newer recording starts", async () => {
    let created = 0;
    dictationIo.request.mockImplementation(async (method) =>
      method === "talk.session.create" ? sessionResult(`dictation-${++created}`) : { ok: true },
    );
    const h = refinementHarness();
    await h.start();
    const first = h.controller.finishActive();
    await h.start();
    transcript("obsolete first", "dictation-1");
    await expect(first).resolves.toBe(false);
    await h.finish("current second", "dictation-2");
    expect(h.controller.review?.rawText).toBe("current second");
    expect(h.controller.insertReviewed()).toBe(true);
    expect(h.target.value).toBe("Current second.");
    expect(h.commit).toHaveBeenCalledOnce();
  });

  it("keeps an incomplete timeout visibly recoverable without making it insertable", async () => {
    const h = refinementHarness();
    await h.start();
    emit({ type: "partial", text: "unfinished recognized words" });
    const finished = h.controller.finishActive();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(finished).resolves.toBe(false);
    expect(h.controller.review).toMatchObject({
      rawText: "unfinished recognized words",
      result: { status: "unavailable", reasons: ["incomplete-transcript"] },
      limitation: "transcript-incomplete",
      canInsert: false,
    });
    expect(h.controller.insertReviewed()).toBe(false);
    expect(h.target.value).toBe("");
  });

  it.each(["close", "error"])(
    "does not present an earlier final as complete after a newer provisional revision and %s",
    async (ending) => {
      const h = refinementHarness();
      await h.start();
      transcript("earlier final");
      const finished = h.controller.finishActive();
      emit({ type: "partial", text: "unfinished later words" });
      emit(
        ending === "close"
          ? { type: "close", reason: "completed" }
          : { type: "error", message: "Provider failed during finalization" },
      );
      await expect(finished).resolves.toBe(false);
      expect(h.controller.review).toMatchObject({
        rawText: "earlier final",
        revision: 2,
        limitation: "transcript-incomplete",
        canInsert: false,
      });
      expect(h.controller.insertReviewed()).toBe(false);
      expect(h.commit).not.toHaveBeenCalled();
    },
  );

  it("rechecks the actual target after delivery admission and refuses a concurrent edit", async () => {
    const h = refinementHarness();
    await h.start();
    await h.finish("hello world");
    const unsubscribe = h.controller.subscribe(() => {
      if (h.controller.review?.delivery === "pending") {
        h.target.value = "newer user intent";
        h.target.dispatchEvent(new Event("input"));
      }
    });
    expect(h.controller.insertReviewed()).toBe(false);
    unsubscribe();
    expect(h.controller.review?.delivery).toBe("not-committed");
    expect(h.controller.pendingReview).toBe(false);
    expect(h.target.value).toBe("newer user intent");
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("preserves an unknown write receipt through cancellation and refuses duplicate delivery", async () => {
    const h = refinementHarness();
    let pendingDuringCommit: boolean | undefined;
    h.commit.mockImplementationOnce((text) => {
      h.write(text);
      h.controller.cancel();
      pendingDuringCommit = h.controller.pendingReview;
      throw new Error("receipt unavailable after the local write");
    });
    await h.start();
    await h.finish("hello world");
    expect(h.controller.insertReviewed()).toBe(false);
    expect(pendingDuringCommit).toBe(true);
    expect(h.target.value).toBe("Hello world.");
    expect(h.controller.review?.delivery).toBe("outcome-unknown");
    expect(h.controller.pendingReview).toBe(false);
    expect(h.controller.review?.canUndo).toBe(false);
    expect(h.controller.insertReviewed()).toBe(false);
    expect(h.controller.chooseOriginal()).toBe(false);
    expect(h.commit).toHaveBeenCalledOnce();
  });

  it("undoes only its known insertion and cannot reinsert or undo it twice", async () => {
    const h = refinementHarness();
    h.target.value = "original draft";
    h.target.setSelectionRange(0, h.target.value.length);
    await h.start();
    await h.finish("hello world");
    expect(h.controller.insertReviewed()).toBe(true);
    expect(h.target.value).toBe("Hello world.");
    expect(h.controller.review?.canUndo).toBe(true);
    expect(h.controller.undoReviewed()).toBe(true);
    expect(h.target.value).toBe("original draft");
    expect(h.controller.review).toMatchObject({ canUndo: false, undoOutcome: "undone" });
    expect(h.controller.undoReviewed()).toBe(false);
    expect(h.controller.insertReviewed()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect([h.target.selectionStart, h.target.selectionEnd]).toEqual([0, 14]);
  });

  it.each(["edit", "target", "new capture", "cancel"])(
    "retires the insertion undo receipt after %s",
    async (change) => {
      const h = refinementHarness();
      await h.start();
      await h.finish("hello world");
      expect(h.controller.insertReviewed()).toBe(true);
      if (change === "edit") {
        h.target.value = "manual edit";
        h.target.dispatchEvent(new Event("input"));
        h.target.value = "Hello world.";
        h.target.dispatchEvent(new Event("input"));
      } else if (change === "target") {
        h.replaceTarget(document.createElement("textarea"));
        h.controller.update(h.options);
        h.replaceTarget(h.target);
      } else if (change === "new capture") {
        await h.start();
      } else {
        h.controller.cancel();
      }
      h.controller.update(h.options);
      expect(h.controller.undoReviewed()).toBe(false);
      expect(h.target.value).toBe("Hello world.");
    },
  );

  it.each(["insert", "undo"])(
    "reports an unknown %s receipt when an input handler replaces the attempted write",
    async (action) => {
      const h = refinementHarness();
      await h.start();
      await h.finish("hello world");
      if (action === "undo") {
        expect(h.controller.insertReviewed()).toBe(true);
      }
      h.target.addEventListener(
        "input",
        () => {
          h.target.value = "newer user text";
        },
        { once: true },
      );
      expect(
        action === "insert" ? h.controller.insertReviewed() : h.controller.undoReviewed(),
      ).toBe(false);
      expect(
        action === "insert" ? h.controller.review?.delivery : h.controller.review?.undoOutcome,
      ).toBe("outcome-unknown");
      expect(h.target.value).toBe("newer user text");
      expect(h.controller.insertReviewed()).toBe(false);
      expect(h.controller.undoReviewed()).toBe(false);
      expect(h.commit).toHaveBeenCalledOnce();
    },
  );

  it("updates the actual review controls through raw selection, reprocess, insertion and undo", async () => {
    const h = refinementHarness();
    const mounted = mountSolid(() => {
      const owner = projectOwner(h.controller, (value) => value);
      return createComponent(ComposerDictationStatus, { readDictation: owner.read });
    });
    const button = (label: string) => {
      const found = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.textContent?.trim() === label,
      );
      assert.isDefined(found);
      return found;
    };
    const texts = () =>
      [
        ...mounted.container.querySelectorAll<HTMLTextAreaElement>(".dictation-review textarea"),
      ].map((node) => node.value);
    await h.start();
    await h.finish("hello world");
    await vi.dynamicImportSettled();
    await waitForFast(() => expect(texts()).toEqual(["hello world", "Hello world."]));
    button("Use original").click();
    await waitForFast(() => expect(texts()).toEqual(["hello world", "hello world"]));
    const mode = mounted.container.querySelector<HTMLSelectElement>("select");
    assert.isNotNull(mode);
    mode.value = "automatic";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    button("Reprocess original").click();
    await waitForFast(() => expect(texts()).toEqual(["hello world", "Hello world."]));
    expect(h.target.value).toBe("");
    button("Insert into draft").click();
    await waitForFast(() => expect(h.target.value).toBe("Hello world."));
    await waitForFast(() => expect(button("Insert into draft").disabled).toBe(true));
    button("Undo dictation insertion").click();
    await waitForFast(() => expect(h.target.value).toBe(""));
    await waitForFast(() =>
      expect(mounted.container.textContent).toContain("The dictation insertion was undone."),
    );
    button("Dismiss review").click();
    await waitForFast(() =>
      expect(mounted.container.querySelector(".dictation-review")).toBeNull(),
    );
    expect(document.activeElement).toBe(h.target);
    expect(dictationIo.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });

  it("returns focus to the unchanged field when Escape dismisses an unsent review", async () => {
    const h = refinementHarness();
    await h.start();
    await h.finish("hello world");
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(h.controller.review).toBeNull();
    expect(document.activeElement).toBe(h.target);
    expect(h.target.value).toBe("");
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("does not steal focus when dismissal replaces the destination synchronously", async () => {
    const h = refinementHarness();
    await h.start();
    await h.finish("hello world");
    const replacement = document.createElement("textarea");
    document.body.append(replacement);
    const unsubscribe = h.controller.subscribe(() => {
      if (!h.controller.review) {
        h.replaceTarget(replacement);
        replacement.focus();
      }
    });
    h.controller.dismissReview();
    unsubscribe();
    expect(document.activeElement).toBe(replacement);
    expect(h.target.value).toBe("");
  });
});
