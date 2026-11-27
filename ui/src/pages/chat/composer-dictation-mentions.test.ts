// @vitest-environment jsdom
import { createRoot } from "solid-js";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import { readComposerEditor, selectComposerInput } from "../../lib/composer-input.ts";
import * as idleImports from "../../lib/idle-import.ts";
import { createMentionComposerBinding } from "../../lib/reactive/composer-editor.ts";
import { createComposerProps } from "./chat-composer.test-support.ts";
import { createComposerDictationOptions } from "./components/chat-composer-dictation-options.ts";
import {
  commitComposerDraft,
  getChatComposerState,
  resetChatComposerState,
} from "./components/chat-composer-state.ts";
import { mountMentionComposerEditor } from "./components/composer-editor-mentions.tsx";
import {
  controllerFixture,
  createClient,
  emit,
  refinementTextareas,
  setupDictationFixtures,
  startDirect,
  transcript,
  type ControllerOptions,
} from "./composer-dictation.test-support.ts";
import { createDirectDictationTextarea } from "./composer-direct-dictation.ts";
import { ComposerMicrophoneOwner } from "./composer-microphone-picker.ts";

setupDictationFixtures();

const initial = "@Alex @Alex @Alex";
const initialMentions: readonly HumanMention[] = [
  { profileId: "alex-first", start: 0, end: 5 },
  { profileId: "alex-middle", start: 6, end: 11 },
  { profileId: "alex-last", start: 12, end: 17 },
];
const spaced = "@Alex  @Alex @Alex";
const spacedMentions: readonly HumanMention[] = [
  { profileId: "alex-first", start: 0, end: 5 },
  { profileId: "alex-middle", start: 7, end: 12 },
  { profileId: "alex-last", start: 13, end: 18 },
];

function mentionHarness(
  kind: "chat" | "direct",
  editorState: "loaded" | "pending" | "failed" = "loaded",
) {
  const container = document.createElement("div");
  const input = document.createElement("textarea");
  input.value = initial;
  container.append(input);
  document.body.append(container);
  let draft = initial;
  let mentions = initialMentions;
  let options: Omit<Partial<ControllerOptions>, "client">;
  let capture: () => void;
  let onInput = () => {
    mentions = updateHumanMentions(draft, input.value, mentions);
    draft = input.value;
  };

  if (kind === "chat") {
    const props = createComposerProps({
      gatewayClient: createClient(),
      connected: true,
      draft,
      getDraft: () => draft,
      getMentions: () => mentions,
      onDraftChange: (value: string, selected?: readonly HumanMention[]) => {
        draft = value;
        mentions = selected ?? [];
      },
    });
    const state = getChatComposerState(props.paneId);
    state.composerTextarea = input;
    const picker = new ComposerMicrophoneOwner();
    options = {
      ...createComposerDictationOptions(props, state, picker, () => {}),
      dictationAvailable: true,
    };
    capture = () => {
      state.dictation = owner;
      state.dictationSelection = {
        value: draft,
        start: input.selectionStart,
        end: input.selectionEnd,
      };
    };
    onInput = () =>
      commitComposerDraft(props, input.value, updateHumanMentions(draft, input.value, mentions));
    onTestFinished(() => {
      resetChatComposerState(props.paneId);
      picker.dispose();
    });
  } else {
    const textarea = createDirectDictationTextarea(() => input);
    refinementTextareas.push(textarea);
    capture = () => textarea.captureSelection();
    options = {
      readRefinementTarget: () => textarea.readTarget(),
      onCommit: (text, late, preservePreview, reviewed) => {
        const result = textarea.insertTranscript(
          (...args) => owner.placeTranscript(...args),
          text,
          late,
          preservePreview,
          reviewed,
        );
        return typeof result === "string" ? true : (result ?? false);
      },
    };
  }
  input.addEventListener("input", () => onInput());
  let destroyEditor: () => void;
  if (editorState === "loaded") {
    destroyEditor = mountMentionComposerEditor(input, () => mentions).destroy;
  } else {
    // Only chunk availability is controlled. The native binding, exact mention
    // updates, input events, dictation adapters, and transaction receipts are real.
    const loader = vi.spyOn(idleImports, "createIdleImport").mockImplementationOnce(() => ({
      load: () =>
        editorState === "failed"
          ? Promise.reject(new Error("synthetic editor chunk failure"))
          : new Promise<never>(() => {}),
      schedule: () => undefined,
      dispose: () => undefined,
    }));
    try {
      const binding = createRoot((dispose) => ({
        ref: createMentionComposerBinding(() => mentions),
        dispose,
      }));
      binding.ref(input);
      destroyEditor = binding.dispose;
    } finally {
      loader.mockRestore();
    }
  }
  const owner = controllerFixture({
    ...options,
    refinement: { policy: { mode: "explicit", locale: "en-US", explicitEnabled: true } },
  }).controller;
  onTestFinished(() => {
    destroyEditor();
    container.remove();
  });
  return {
    input,
    bridge: () => {
      const bridge = readComposerEditor(input);
      assert.isDefined(bridge);
      return bridge;
    },
    owner,
    value: () => ({ draft, mentions }),
    async review(text: string, start: number, end: number) {
      selectComposerInput(input, start, end);
      capture();
      await startDirect(owner);
      const stopped = owner.finishActive();
      transcript(text);
      emit({ type: "close", reason: "completed" });
      expect(await stopped).toBe(false);
    },
  };
}

describe.each(["chat", "direct"] as const)("%s reviewed dictation with the real editor", (kind) => {
  it.each([
    { selected: "refined", text: "hello, world.", lastStart: 20 },
    { selected: "original", text: "hello comma world period", lastStart: 31 },
  ])("preserves untouched recipients and isolates undo for $selected text", async (choice) => {
    const h = mentionHarness(kind);
    h.bridge().replace(" ", 6, 6);
    expect(h.value()).toEqual({ draft: spaced, mentions: spacedMentions });
    // The selected recipient and both surrounding spaces are replaced. The
    // insertion owner must supply new join spaces without touching either neighbor.
    await h.review("hello comma world period", 5, 13);
    if (choice.selected === "original") {
      expect(h.owner.chooseOriginal()).toBe(true);
    }
    expect(h.owner.review?.result.text).toBe(choice.text);
    selectComposerInput(h.input, 0, 0);
    expect(h.owner.insertReviewed()).toBe(true);
    expect(h.value()).toEqual({
      draft: `@Alex ${choice.text} @Alex`,
      mentions: [
        { profileId: "alex-first", start: 0, end: 5 },
        { profileId: "alex-last", start: choice.lastStart, end: choice.lastStart + 5 },
      ],
    });
    expect(h.owner.undoReviewed()).toBe(true);
    expect(h.value()).toEqual({ draft: spaced, mentions: spacedMentions });
    h.bridge().undo();
    expect(h.value()).toEqual({ draft: initial, mentions: initialMentions });
  });

  it("keeps the last recipient when identical labels make a text diff ambiguous", async () => {
    const h = mentionHarness(kind);
    await h.review("@Alex", 0, 11);
    expect(h.owner.chooseOriginal()).toBe(true);
    expect(h.owner.insertReviewed()).toBe(true);
    expect(h.value()).toEqual({
      draft: "@Alex @Alex",
      mentions: [{ profileId: "alex-last", start: 6, end: 11 }],
    });
    expect(h.owner.undoReviewed()).toBe(true);
    expect(h.value()).toEqual({ draft: initial, mentions: initialMentions });
  });

  it("leaves recipient identities and history intact when original text makes no change", async () => {
    const h = mentionHarness(kind);
    h.bridge().replace(" ", 6, 6);
    await h.review("@Alex", 7, 12);
    expect(h.owner.chooseOriginal()).toBe(true);
    expect(h.owner.insertReviewed()).toBe(false);
    expect(h.value()).toEqual({ draft: spaced, mentions: spacedMentions });
    h.bridge().undo();
    expect(h.value()).toEqual({ draft: initial, mentions: initialMentions });
  });

  it.each(["pending", "failed"] as const)(
    "preserves exact native recipients and undo while the rich editor is %s",
    async (editorState) => {
      const h = mentionHarness(kind, editorState);
      await h.review("@Alex", 0, 11);
      expect(readComposerEditor(h.input)).toBeUndefined();
      expect(h.owner.chooseOriginal()).toBe(true);
      expect(h.owner.insertReviewed()).toBe(true);
      expect(h.value()).toEqual({
        draft: "@Alex @Alex",
        mentions: [{ profileId: "alex-last", start: 6, end: 11 }],
      });
      expect(h.owner.undoReviewed()).toBe(true);
      expect(h.value()).toEqual({ draft: initial, mentions: initialMentions });
    },
  );
});
