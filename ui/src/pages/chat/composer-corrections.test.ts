// @vitest-environment jsdom
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { createComposerDraftSource } from "../../lib/chat/composer-draft-changes.ts";
import { createChatPaneDictationProps } from "./chat-pane-session-controls.ts";
import { createChatPageStateContext } from "./chat-state-context.test-support.ts";
import { createChatState } from "./chat-state-controller.ts";
import { createPageState } from "./chat-state-page.ts";
import { createComposerDictationOptions } from "./components/chat-composer-dictation-options.ts";
import { getChatComposerState, resetChatComposerState } from "./components/chat-composer-state.ts";
import type { ChatComposerProps } from "./components/chat-composer-types.ts";
import { ComposerDictationOwner } from "./composer-dictation.ts";
import { ComposerMicrophoneOwner } from "./composer-microphone-picker.ts";
import { audioFixture, MockDictationAudioContext } from "./talk/input.test-support.ts";

// Transcript injection and mocked microphone/Gateway I/O exercise the real capture,
// finalization, correction and publication owners. They do not prove acoustic accuracy.
type Options = ConstructorParameters<typeof ComposerDictationOwner>[0];
const owners: ComposerDictationOwner[] = [];
const composerScopes: { paneId: string; dispose: () => void }[] = [];
let mediaDescriptor: PropertyDescriptor | undefined;

class SilentAudio extends EventTarget {
  readonly play = vi.fn(async () => undefined);
  readonly pause = vi.fn();
  readonly load = vi.fn();
  readonly removeAttribute = vi.fn();
}

function fixture(overrides: Partial<Options> = {}, initialDraft = "Existing field text.") {
  const listeners = new Set<(event: GatewayEventFrame) => void>();
  let captures = 0;
  let draft = initialDraft;
  let revision = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "talk.session.create") {
      const sessionId = `capture-${++captures}`;
      return {
        sessionId,
        transcriptionSessionId: sessionId,
        audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
      };
    }
    if (method === "talk.session.close" || method === "talk.session.appendAudio") {
      return { ok: true };
    }
    throw new Error(`Unexpected dictation effect: ${method}`);
  });
  // SAFETY: Only the Gateway request/listener boundary is replaced; capture and publication stay real.
  const createClient = () =>
    ({
      request,
      addEventListener: (listener: (event: GatewayEventFrame) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }) as unknown as GatewayBrowserClient;
  const client = createClient();
  const onCommit = vi.fn((text: string, late?: true, preservePreview?: true) => {
    const placement = owner.placeTranscript(
      text,
      null,
      { start: draft.length, end: draft.length, value: draft },
      late,
      preservePreview,
    );
    if (placement) {
      draft = placement.value;
      revision += 1;
    }
  });
  const options: Options = {
    client,
    connected: true,
    enabled: true,
    sessionKey: "agent:main:one",
    draftKey: "draft-one",
    contextKey: "account-one",
    corrections: { mode: "explicit", locale: "en-US" },
    getDraftRevision: () => revision,
    realtimeTalkActive: false,
    onCommit,
    onError: vi.fn(),
    ...overrides,
  };
  const owner = new ComposerDictationOwner(options);
  owners.push(owner);
  const emit = (payload: Record<string, unknown>, capture = captures) => {
    for (const listener of listeners) {
      listener({
        type: "event",
        event: "talk.event",
        payload: { transcriptionSessionId: `capture-${capture}`, ...payload },
      });
    }
  };
  const final = (text: string, capture = captures) =>
    emit({ type: "transcript", text, final: true }, capture);
  return {
    owner,
    options,
    request,
    onCommit,
    createClient,
    emit,
    final,
    retainFinal: (text: string, capture = captures) => {
      const queuedListeners = [...listeners];
      return () => {
        for (const listener of queuedListeners) {
          listener({
            type: "event",
            event: "talk.event",
            payload: {
              transcriptionSessionId: `capture-${capture}`,
              type: "transcript",
              text,
              final: true,
            },
          });
        }
      };
    },
    draft: () => draft,
    edit: (value = draft) => {
      draft = value;
      revision += 1;
      owner.update(options);
    },
    async start() {
      expect(owner.startDirect()).toBe(true);
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.connecting).toBe(false);
      expect(owner.active).toBe(true);
    },
    async finish(text: string) {
      const completed = owner.finishActive();
      final(text);
      emit({ type: "close", reason: "completed" });
      return completed;
    },
  };
}

function composerBoundary(h: ReturnType<typeof fixture>) {
  const paneId = crypto.randomUUID();
  const state = createRoot((dispose) => {
    composerScopes.push({ paneId, dispose });
    return getChatComposerState(paneId);
  });
  let draft = h.draft();
  const draftSource = createComposerDraftSource(() => ({
    draft,
    mentions: [],
    attachments: [],
    pendingAttachmentReads: 0,
  }));
  const textarea = document.createElement("textarea");
  textarea.value = draft;
  textarea.setSelectionRange(0, draft.length);
  state.composerTextarea = textarea;
  state.dictationSelection = { start: 0, end: draft.length, value: draft };
  state.dictation = h.owner;
  const picker = new ComposerMicrophoneOwner();
  picker.dictationStatus = "ready";
  state.microphonePicker = picker;
  const props: ChatComposerProps = {
    paneId,
    sessionKey: "agent:main:one",
    currentSessionId: "physical-one",
    currentAgentId: "main",
    connected: true,
    canSend: true,
    canCompose: true,
    disabledReason: null,
    sending: false,
    messages: [],
    stream: null,
    queue: [],
    draft,
    draftSource,
    getDraft: () => draft,
    captureDictationDraft: () => draftSource.captureRevision(),
    modelCatalog: [],
    modelSwitching: false,
    sessions: null,
    assistantName: "OpenClaw",
    gatewayClient: h.options.client,
    dictationContextKey: "account-one",
    composerCorrections: { version: 1, mode: "explicit", locale: "en-US" },
    onDraftChange: vi.fn((next) => {
      draft = next;
      draftSource.publish();
    }),
    onSend: vi.fn(),
    onQueueRemove: vi.fn(),
  };
  const update = (patch: Partial<ChatComposerProps> = {}) => {
    Object.assign(props, patch);
    h.owner.update(createComposerDictationOptions(props, state, picker, vi.fn()));
  };
  update();
  return { props, textarea, update, draft: () => draft, editRevision: () => state.editRevision };
}

beforeEach(() => {
  vi.useFakeTimers();
  mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => audioFixture().stream) },
  });
  vi.stubGlobal("AudioContext", MockDictationAudioContext);
  vi.stubGlobal("Audio", SilentAudio);
});

afterEach(async () => {
  for (const { paneId, dispose } of composerScopes.splice(0)) {
    resetChatComposerState(paneId);
    dispose();
  }
  for (const owner of owners.splice(0)) {
    owner.dispose();
  }
  await vi.advanceTimersByTimeAsync(0);
  if (mediaDescriptor) {
    Object.defineProperty(navigator, "mediaDevices", mediaDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("spoken corrections through composer dictation", () => {
  it.each(["original", "correction"] as const)(
    "keeps a preexisting selected draft when the production insertion adapter accepts %s",
    async (choice) => {
      const h = fixture();
      const composer = composerBoundary(h);
      await h.start();
      await h.finish("Tuesday sorry Wednesday");
      expect(h.owner.resolveCorrection(choice)).toBe(true);
      const inserted = choice === "original" ? "Tuesday sorry Wednesday" : "Wednesday";
      expect(composer.draft()).toBe(`Existing field text. ${inserted}`);
      expect(composer.textarea.value).toBe(composer.draft());
      expect(composer.props.onDraftChange).toHaveBeenCalledOnce();
      expect(composer.props.onSend).not.toHaveBeenCalled();
    },
  );

  it.each(["finalizing", "review"])(
    "retires %s corrections when the composer loses permission, including later restoration",
    async (phase) => {
      const h = fixture();
      const composer = composerBoundary(h);
      await h.start();
      const stopped = h.owner.finishActive();
      const queuedFinal = h.retainFinal("Tuesday sorry Wednesday");
      if (phase === "review") {
        queuedFinal();
        h.emit({ type: "close", reason: "completed" });
        expect(await stopped).toBe(false);
        expect(h.owner.correctionReview?.canAccept).toBe(true);
      }
      composer.update({ canCompose: false });
      composer.update({ canCompose: true });
      queuedFinal();
      expect(await stopped).toBe(false);
      expect(h.owner.correctionReview).toBeNull();
      expect(h.owner.resolveCorrection("original")).toBe(false);
      expect(h.owner.resolveCorrection("correction")).toBe(false);
      expect(composer.draft()).toBe("Existing field text.");
      expect(composer.props.onDraftChange).not.toHaveBeenCalled();
    },
  );

  describe.each([
    ["new text", ["New external draft"]],
    ["equal text", ["Existing field text."]],
    ["A to B to A", ["New external draft", "Existing field text."]],
  ] as const)("external draft publication: %s", (_change, values) => {
    it.each(["finalizing", "review"])(
      "invalidates the capture while %s without a component edit revision",
      async (phase) => {
        const h = fixture();
        const composer = composerBoundary(h);
        await h.start();
        const revision = composer.editRevision();
        const stopped = h.owner.finishActive();
        const publish = () => {
          for (const value of values) {
            composer.props.onDraftChange(value);
          }
        };
        if (phase === "finalizing") {
          publish();
        }
        h.final("Tuesday sorry Wednesday");
        h.emit({ type: "close", reason: "completed" });
        expect(await stopped).toBe(false);
        if (phase === "review") {
          expect(h.owner.correctionReview?.canAccept).toBe(true);
          publish();
        }
        expect(composer.editRevision()).toBe(revision);
        expect(h.owner.correctionReview).toMatchObject({
          invalidated: true,
          canAccept: false,
          canKeepOriginal: false,
          result: { original: "Tuesday sorry Wednesday" },
        });
        expect(h.owner.resolveCorrection("original")).toBe(false);
        expect(h.owner.resolveCorrection("correction")).toBe(false);
        expect(composer.draft()).toBe(values.at(-1));
        expect(composer.props.onDraftChange).toHaveBeenCalledTimes(values.length);
      },
    );
  });

  it("does not insert unchanged raw text after an external replacement during recording", async () => {
    const h = fixture();
    const composer = composerBoundary(h);
    await h.start();
    const revision = composer.editRevision();
    composer.props.onDraftChange("New external draft");
    expect(await h.finish("Already resolved Wednesday")).toBe(false);
    expect(composer.editRevision()).toBe(revision);
    expect(h.owner.correctionReview).toMatchObject({
      canAccept: false,
      canKeepOriginal: false,
      result: { original: "Already resolved Wednesday", status: "unchanged" },
    });
    expect(composer.draft()).toBe("New external draft");
    expect(composer.props.onDraftChange).toHaveBeenCalledOnce();
  });

  it.each(["finalizing", "review"])(
    "retires %s corrections when the physical session changes under the same key and returns",
    async (phase) => {
      const h = fixture();
      const composer = composerBoundary(h);
      await h.start();
      const stopped = h.owner.finishActive();
      const queuedFinal = h.retainFinal("Tuesday sorry Wednesday");
      if (phase === "review") {
        queuedFinal();
        h.emit({ type: "close", reason: "completed" });
        expect(await stopped).toBe(false);
        expect(h.owner.correctionReview?.canAccept).toBe(true);
      }
      composer.update({ currentSessionId: "physical-two" });
      composer.update({ currentSessionId: "physical-one" });
      queuedFinal();
      expect(await stopped).toBe(false);
      expect(h.owner.correctionReview).toBeNull();
      expect(h.owner.resolveCorrection("original")).toBe(false);
      expect(h.owner.resolveCorrection("correction")).toBe(false);
      expect(composer.props.sessionKey).toBe("agent:main:one");
      expect(composer.draft()).toBe("Existing field text.");
      expect(composer.props.onDraftChange).not.toHaveBeenCalled();
    },
  );

  it("rejects an equal-text replacement through the real ChatState draft handler", async () => {
    const h = fixture();
    const composer = composerBoundary(h);
    const chat = createChatState({ awaitDomCommit: async () => true });
    onTestFinished(chat.dispose);
    const page = createPageState(createChatPageStateContext(), chat.createRenderLifecycle(), {
      sessionKey: "agent:main:one",
      dispatchEvent: () => true,
    });
    page.chatMessage = composer.draft();
    chat.attach(page);
    composer.update({
      draftSource: chat.composerDraft,
      getDraft: () => page.chatMessage,
      captureDictationDraft: createChatPaneDictationProps(
        page,
        chat.composerDraft,
        () => true,
        "test-profile",
      ).captureDictationDraft,
      onDraftChange: (value) => page.handleChatDraftChange(value),
    });
    await h.start();
    await h.finish("Tuesday sorry Wednesday");
    expect(h.owner.correctionReview?.canAccept).toBe(true);
    const revision = composer.editRevision();
    page.handleChatDraftChange(page.chatMessage);
    expect(composer.editRevision()).toBe(revision);
    expect(h.owner.correctionReview).toMatchObject({ canAccept: false, canKeepOriginal: false });
    expect(h.owner.resolveCorrection("correction")).toBe(false);
    expect(page.chatMessage).toBe("Existing field text.");
  });

  it.each([
    ["Do not send it Tuesday sorry Wednesday", "Do not send it Wednesday"],
    ["The total is fifteen no fifty dollars", "The total is fifty dollars"],
    ["Tuesday, no Wednesday, actually Thursday", "Thursday"],
    ["Meet Tuesday. scratch that last sentence", ""],
  ])("reviews %j before applying it once to the current draft", async (spoken, corrected) => {
    const h = fixture();
    await h.start();
    expect(await h.finish(spoken)).toBe(false);
    expect(h.draft()).toBe("Existing field text.");
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.owner.correctionReview).toMatchObject({
      canAccept: true,
      canKeepOriginal: true,
      result: { original: spoken, candidate: corrected, status: "needs-review" },
    });
    expect(h.owner.resolveCorrection("correction")).toBe(true);
    expect(h.draft()).toBe(`Existing field text.${corrected ? ` ${corrected}` : ""}`);
    expect(h.owner.resolveCorrection("correction")).toBe(false);
    expect(h.owner.resolveCorrection("original")).toBe(false);
    expect(h.onCommit).toHaveBeenCalledTimes(corrected ? 1 : 0);
    expect(h.request.mock.calls.map(([method]) => method)).toEqual([
      "talk.session.create",
      "talk.session.close",
    ]);
  });

  it.each(["Tell John that John should call change John to James", "scratch that last sentence"])(
    "keeps ambiguous or unowned %j recoverable without guessing",
    async (spoken) => {
      const h = fixture();
      await h.start();
      expect(await h.finish(spoken)).toBe(false);
      expect(h.owner.correctionReview).toMatchObject({
        canAccept: false,
        canKeepOriginal: true,
        result: { original: spoken, candidate: spoken, plan: null },
      });
      expect(h.owner.resolveCorrection("correction")).toBe(false);
      expect(h.draft()).toBe("Existing field text.");
      expect(h.owner.resolveCorrection("original")).toBe(true);
      h.final("Tuesday sorry Wednesday");
      expect(h.draft()).toBe(`Existing field text. ${spoken}`);
      expect(h.owner.correctionReview).toBeNull();
      expect(h.onCommit).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, { mode: "off", locale: "en-US" }] as const)(
    "preserves ordinary raw dictation with policy %j",
    async (corrections) => {
      const h = fixture({ corrections });
      await h.start();
      expect(await h.finish("Tuesday sorry Wednesday")).toBe(true);
      expect(h.owner.correctionReview).toBeNull();
      expect(h.draft()).toBe("Existing field text. Tuesday sorry Wednesday");
    },
  );

  it("uses Literal for one capture and restores explicit review for the next", async () => {
    const h = fixture();
    h.owner.setLiteral(true);
    await h.start();
    expect(h.owner.literal).toBe(true);
    expect(await h.finish("Tuesday sorry Wednesday")).toBe(true);
    expect(h.owner.correctionReview).toBeNull();
    expect(h.draft()).toBe("Existing field text. Tuesday sorry Wednesday");
    await h.start();
    expect(h.owner.literal).toBe(false);
    expect(await h.finish("Tuesday sorry Wednesday")).toBe(false);
    expect(h.owner.correctionReview?.canAccept).toBe(true);
  });

  it("does not turn dictated application commands into tool or agent requests", async () => {
    const h = fixture();
    await h.start();
    expect(await h.finish("Actually open the browser and buy it")).toBe(true);
    expect(h.draft()).toBe("Existing field text. Actually open the browser and buy it");
    expect(h.options.realtimeTalkActive).toBe(false);
    expect(h.request.mock.calls.map(([method]) => method)).toEqual([
      "talk.session.create",
      "talk.session.close",
    ]);
  });

  it.each(["before finalization", "during review"])(
    "invalidates equal-text user edits %s without losing the recognized original",
    async (when) => {
      const h = fixture();
      await h.start();
      const stopped = h.owner.finishActive();
      if (when === "before finalization") {
        h.edit();
      }
      h.final("Tuesday sorry Wednesday");
      h.emit({ type: "close", reason: "completed" });
      expect(await stopped).toBe(false);
      if (when === "during review") {
        h.edit();
      }
      expect(h.owner.correctionReview).toMatchObject({
        invalidated: true,
        canAccept: false,
        canKeepOriginal: false,
        result: { original: "Tuesday sorry Wednesday" },
      });
      expect(h.owner.resolveCorrection("correction")).toBe(false);
      expect(h.owner.resolveCorrection("original")).toBe(false);
      expect(h.draft()).toBe("Existing field text.");
      expect(h.onCommit).not.toHaveBeenCalled();
    },
  );

  it.each(["draft", "session", "context", "client", "Talk", "cancel"])(
    "retires review across %s changes, including returning to the original target",
    async (change) => {
      const h = fixture();
      await h.start();
      await h.finish("Tuesday sorry Wednesday");
      expect(h.owner.correctionReview?.canAccept).toBe(true);
      if (change === "cancel") {
        h.owner.cancel();
      } else {
        const patch: Partial<Options> =
          change === "draft"
            ? { draftKey: "another-draft" }
            : change === "session"
              ? { sessionKey: "agent:main:another" }
              : change === "context"
                ? { contextKey: "another-account" }
                : change === "client"
                  ? { client: h.createClient() }
                  : { realtimeTalkActive: true };
        h.owner.update({ ...h.options, ...patch });
        h.owner.update(h.options);
      }
      expect(h.owner.correctionReview).toBeNull();
      expect(h.owner.resolveCorrection("correction")).toBe(false);
      expect(h.owner.resolveCorrection("original")).toBe(false);
      expect(h.onCommit).not.toHaveBeenCalled();
      expect(h.draft()).toBe("Existing field text.");
    },
  );

  it.each(["recording", "finalizing"])(
    "preserves recognized text when the connection fails while %s",
    async (phase) => {
      const h = fixture();
      await h.start();
      const original = "Do not send it Tuesday sorry Wednesday";
      h.emit({ type: "partial", text: original });
      const stopped = phase === "finalizing" ? h.owner.finishActive() : null;
      h.owner.update({ ...h.options, connected: false });
      if (stopped) {
        expect(await stopped).toBe(false);
      }
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.owner.correctionReview).toMatchObject({
        canAccept: false,
        canKeepOriginal: false,
        result: { original },
      });
      expect(h.owner.resolveCorrection("correction")).toBe(false);
      expect(h.owner.resolveCorrection("original")).toBe(false);
      expect(h.onCommit).not.toHaveBeenCalled();
      h.owner.update(h.options);
      expect(h.owner.correctionReview).toMatchObject({ canAccept: false, canKeepOriginal: true });
      expect(h.owner.resolveCorrection("original")).toBe(true);
      expect(h.draft()).toBe(`Existing field text. ${original}`);
    },
  );

  it.each(["contextKey", "sessionKey"] as const)(
    "ignores an already queued final after %s leaves and returns to the same target",
    async (key) => {
      const h = fixture();
      await h.start();
      const stopped = h.owner.finishActive();
      const queuedFinal = h.retainFinal("Tuesday sorry Wednesday");
      h.owner.update({ ...h.options, [key]: "another-target" });
      h.owner.update(h.options);
      queuedFinal();
      expect(await stopped).toBe(false);
      await vi.dynamicImportSettled();
      expect(h.owner.correctionReview).toBeNull();
      expect(h.owner.resolveCorrection("correction")).toBe(false);
      expect(h.onCommit).not.toHaveBeenCalled();
      expect(h.draft()).toBe("Existing field text.");
    },
  );

  it("retires a previous capture before accepting a new final with identical text", async () => {
    const h = fixture();
    await h.start();
    const previous = h.owner.finishActive();
    await h.start();
    h.final("Tuesday sorry Wednesday", 1);
    h.emit({ type: "close", reason: "completed" }, 1);
    expect(await previous).toBe(false);
    expect(h.owner.resolveCorrection("correction")).toBe(false);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(await h.finish("Tuesday sorry Wednesday")).toBe(false);
    expect(h.owner.resolveCorrection("correction")).toBe(true);
    expect(h.draft()).toBe("Existing field text. Wednesday");
    expect(h.onCommit).toHaveBeenCalledTimes(1);
  });

  it("disabling corrections preserves original recovery but retires the prepared candidate", async () => {
    const h = fixture();
    await h.start();
    await h.finish("Tuesday sorry Wednesday");
    h.owner.update({ ...h.options, corrections: { mode: "off", locale: "en-US" } });
    expect(h.owner.correctionReview).toMatchObject({ canAccept: false, canKeepOriginal: true });
    expect(h.owner.resolveCorrection("correction")).toBe(false);
    expect(h.owner.resolveCorrection("original")).toBe(true);
    expect(h.draft()).toBe("Existing field text. Tuesday sorry Wednesday");
    h.owner.update(h.options);
    expect(h.owner.resolveCorrection("correction")).toBe(false);
  });
});
