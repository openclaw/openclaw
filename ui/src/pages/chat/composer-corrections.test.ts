// @vitest-environment jsdom
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { resolveCurrentSelfUser } from "../../app/user-profile.ts";
import { createComposerDraftSource } from "../../lib/chat/composer-draft-changes.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { createChatPaneDictationProps } from "./chat-pane-session-controls.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
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

// Drive the actual pane lifecycle before projecting its state into the composer.
function lifecycleBoundary(h: ReturnType<typeof fixture>, profileless = false) {
  const composer = composerBoundary(h);
  const { pane, state: page } = createTestChatPane({ client: h.options.client ?? undefined });
  // Simulate an already attached conversation; the compose target owns its current client.
  Object.assign(pane, { stagedAttachmentGatewayOwner: h.options.client });
  const chat = pane.chatState;
  const gateway = pane.context.gateway;
  pane.sessionKey = page.sessionKey = "agent:main:one";
  page.handleChatDraftChange(composer.draft());
  page.currentSessionId = "physical-one";
  page.settings = {
    ...page.settings,
    composerHoldToRecord: true,
    composerCorrections:
      h.options.corrections?.mode === "explicit"
        ? { version: 1, mode: "explicit", locale: "en-US" }
        : undefined,
  };
  const writes = vi.spyOn(page, "handleChatDraftChange");
  const hello = sessionMutationGatewayHello();
  const connected: ApplicationGatewaySnapshot = {
    ...gateway.snapshot,
    phase: "connected",
    hello: { ...hello, auth: { ...hello.auth, recoveryScope: "account-one" } },
    selfUser: profileless
      ? null
      : { id: "alice", identity: { type: "profile", id: "profile-alice" } },
  };
  const update = (patch: Partial<ApplicationGatewaySnapshot> = {}) => {
    const snapshot = { ...gateway.snapshot, ...patch };
    pane.applyGatewaySnapshot(snapshot);
    const scope = gatewayPresentationScope(gateway);
    const user = resolveCurrentSelfUser({
      snapshotUser:
        snapshot.selfUser === undefined ? (scope.displayUser ?? undefined) : snapshot.selfUser,
    });
    composer.update({
      connected: page.connected,
      gatewayClient: page.client,
      currentSessionId: page.currentSessionId,
      canCompose: hasOperatorWriteAccess(snapshot.hello?.auth ?? null),
      draftSource: chat.composerDraft,
      getDraft: () => page.chatMessage,
      ...createChatPaneDictationProps(
        page,
        chat.composerDraft,
        () => pane.state === page,
        user?.identity?.type === "profile" ? user.identity.id : null,
        gateway,
      ),
      onDraftChange: (value) => page.handleChatDraftChange(value),
    });
  };
  update(connected);
  return { pane, page, writes, gateway, connected, update, composer, chat };
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
  it("cancels on Escape while the actual correction module is still loading", async () => {
    const h = fixture();
    await h.start();
    const entered = createDeferred();
    const release = createDeferred();
    vi.doMock(import("./spoken-corrections.ts"), async (importOriginal) => {
      entered.resolve();
      await release.promise;
      return importOriginal();
    });
    onTestFinished(() => {
      release.resolve();
      vi.doUnmock("./spoken-corrections.ts");
    });
    const stopped = h.finish("Tuesday sorry Wednesday");
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        stopped,
        "Correction preparation settled without reaching the held module boundary",
      );
      expect(h.owner.active).toBe(false);
      expect(h.owner.transcribing).toBe(false);
      expect(h.owner.correctionReview).toBeNull();
      expect(h.owner.correctionCommitRequired).toBe(true);
      const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      document.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(true);
      expect(h.owner.correctionCommitRequired).toBe(false);
      expect(h.onCommit).not.toHaveBeenCalled();

      // Admission belongs to the new capture before the cancelled import finishes.
      expect(h.owner.startDirect()).toBe(true);
      release.resolve();
      expect(await stopped).toBe(false);
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.owner.active).toBe(true);
      expect(h.owner.correctionReview).toBeNull();
      expect(h.onCommit).not.toHaveBeenCalled();
      expect(await h.finish("Fresh capture text.")).toBe(false);
      expect(h.owner.correctionReview).toMatchObject({
        canAccept: false,
        canKeepOriginal: true,
        result: { original: "Fresh capture text.", plan: null },
      });
      expect(h.owner.resolveCorrection("original")).toBe(true);
      expect(h.owner.correctionReview).toBeNull();
      expect(h.draft()).toBe("Existing field text. Fresh capture text.");
      expect(h.onCommit).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await stopped;
    }
  });

  it("keeps a preexisting selected draft when the insertion adapter keeps the original", async () => {
    const h = fixture();
    const composer = composerBoundary(h);
    await h.start();
    await h.finish("Tuesday sorry Wednesday");
    expect(h.owner.resolveCorrection("correction")).toBe(false);
    expect(composer.draft()).toBe("Existing field text.");
    expect(h.owner.resolveCorrection("original")).toBe(true);
    expect(composer.draft()).toBe("Existing field text. Tuesday sorry Wednesday");
    expect(composer.textarea.value).toBe(composer.draft());
    expect(composer.props.onDraftChange).toHaveBeenCalledOnce();
    expect(composer.props.onSend).not.toHaveBeenCalled();
  });

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
        expect(h.owner.correctionReview?.canKeepOriginal).toBe(true);
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
          expect(h.owner.correctionReview?.canKeepOriginal).toBe(true);
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

  it("does not insert the original after an external replacement during recording", async () => {
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
      result: { original: "Already resolved Wednesday", status: "unavailable", plan: null },
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
        expect(h.owner.correctionReview?.canKeepOriginal).toBe(true);
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
    const context = createChatPageStateContext();
    const page = createPageState(context, chat.createRenderLifecycle(), {
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
        context.gateway,
      ).captureDictationDraft,
      onDraftChange: (value) => page.handleChatDraftChange(value),
    });
    await h.start();
    await h.finish("Tuesday sorry Wednesday");
    expect(h.owner.correctionReview?.canKeepOriginal).toBe(true);
    const revision = composer.editRevision();
    page.handleChatDraftChange(page.chatMessage);
    expect(composer.editRevision()).toBe(revision);
    expect(h.owner.correctionReview).toMatchObject({ canAccept: false, canKeepOriginal: false });
    expect(h.owner.resolveCorrection("correction")).toBe(false);
    expect(page.chatMessage).toBe("Existing field text.");
  });

  it.each([
    "Do not send it Tuesday sorry Wednesday",
    "The total is fifteen no fifty dollars",
    "Tuesday, no Wednesday, actually Thursday",
    "Meet Tuesday. scratch that last sentence",
    "I work Tuesday, no Wednesday shifts are available",
  ])("keeps formerly supported or negative %j literal until original is chosen", async (spoken) => {
    const h = fixture();
    await h.start();
    expect(await h.finish(spoken)).toBe(false);
    expect(h.draft()).toBe("Existing field text.");
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.owner.correctionReview).toMatchObject({
      canAccept: false,
      canKeepOriginal: true,
      result: {
        original: spoken,
        candidate: spoken,
        plan: null,
        status: "unavailable",
        reasons: ["corrections-unavailable"],
      },
    });
    expect(h.owner.resolveCorrection("correction")).toBe(false);
    expect(h.owner.resolveCorrection("original")).toBe(true);
    expect(h.draft()).toBe(`Existing field text. ${spoken}`);
    expect(h.owner.resolveCorrection("original")).toBe(false);
    expect(h.onCommit).toHaveBeenCalledOnce();
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
    expect(h.owner.correctionReview?.canKeepOriginal).toBe(true);
  });

  it("does not turn dictated application commands into tool or agent requests", async () => {
    const h = fixture();
    await h.start();
    expect(await h.finish("Actually open the browser and buy it")).toBe(false);
    expect(h.draft()).toBe("Existing field text.");
    expect(h.owner.resolveCorrection("correction")).toBe(false);
    expect(h.owner.resolveCorrection("original")).toBe(true);
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
      expect(h.owner.correctionReview?.canKeepOriginal).toBe(true);
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

  it.each([
    ["off", "recording"],
    ["off", "finalizing"],
    ["explicit", "recording"],
    ["explicit", "finalizing"],
    ["explicit", "review"],
  ] as const)("keeps %s raw recovery across the real lifecycle while %s", async (mode, phase) => {
    const h = fixture({ corrections: { mode, locale: "en-US" } });
    const boundary = lifecycleBoundary(h);
    await h.start();
    const original = "Do not send it Tuesday sorry Wednesday";
    h.emit({ type: "partial", text: original });
    const stopped = phase === "finalizing" ? h.owner.finishActive() : null;
    if (phase === "review") {
      await h.finish(original);
      expect(h.owner.correctionReview?.canKeepOriginal).toBe(true);
    }
    const epoch = boundary.pane.connectionGeneration;
    const sessionId = boundary.page.currentSessionId;
    const isDraftCurrent = boundary.chat.composerDraft.captureRevision();
    const editRevision = boundary.composer.editRevision();
    // Transport loss retains the client but clears the handshake and profile read.
    boundary.update({ phase: "reconnecting", hello: null, selfUser: undefined });
    expect(boundary.pane.connectionGeneration).toBeGreaterThan(epoch);
    expect(boundary.page.connectionEpoch).toBe(boundary.pane.connectionGeneration);
    await stopped;
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
    if (mode === "explicit") {
      expect(h.owner.correctionReview).toMatchObject({
        canAccept: false,
        canKeepOriginal: false,
        result: { original },
      });
      expect(h.owner.resolveCorrection("original")).toBe(false);
      expect(boundary.writes).not.toHaveBeenCalled();
    } else {
      expect(boundary.page.chatMessage).toBe(original);
      expect(boundary.writes).toHaveBeenCalledTimes(1);
    }
    boundary.update(boundary.connected);
    if (mode === "explicit") {
      expect(boundary.page.currentSessionId, "physical session").toBe(sessionId);
      expect(isDraftCurrent(), "draft publication").toBe(true);
      expect(boundary.composer.editRevision(), "composer edit revision").toBe(editRevision);
      expect(boundary.composer.props.canCompose, "compose authority").toBe(true);
      expect(h.owner.correctionReview).toMatchObject({ canAccept: false, canKeepOriginal: true });
      expect(h.owner.resolveCorrection("correction")).toBe(false);
      expect(h.owner.resolveCorrection("original")).toBe(true);
      expect(h.owner.resolveCorrection("original")).toBe(false);
    }
    h.final(original);
    h.emit({ type: "close", reason: "completed" });
    await vi.advanceTimersByTimeAsync(0);
    // Off retains the ordinary selected-text placement; Explicit owns only capture text.
    expect(boundary.page.chatMessage).toBe(
      mode === "off" ? original : `Existing field text. ${original}`,
    );
    expect(boundary.writes).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });

  it.each([
    ["off", "delayed final"],
    ["off", "timeout"],
    ["off", "failure"],
    ["explicit", "delayed final"],
    ["explicit", "timeout"],
    ["explicit", "failure"],
  ] as const)(
    "retains %s received text after %s through the production pane",
    async (mode, outcome) => {
      const h = fixture({ corrections: { mode, locale: "en-US" } });
      const boundary = lifecycleBoundary(h);
      await h.start();
      const preview = "Keep the received preview";
      const final = "Keep the received final";
      h.emit({ type: "partial", text: preview });
      const stopped = h.owner.finishActive();
      const duplicateFinal = h.retainFinal(final);
      await vi.advanceTimersByTimeAsync(0);
      if (outcome === "timeout") {
        await vi.advanceTimersByTimeAsync(10_000);
      } else {
        h.final(final);
        h.emit(
          outcome === "failure"
            ? { type: "error", message: "Controlled finalization failure" }
            : { type: "close", reason: "completed" },
        );
      }
      expect(await stopped).toBe(mode === "off");
      const expected = outcome === "delayed final" ? final : preview;
      if (mode === "explicit") {
        expect(h.owner.correctionReview).toMatchObject({
          canAccept: false,
          canKeepOriginal: true,
          result: { original: expected, candidate: expected, plan: null },
        });
        expect(boundary.writes).not.toHaveBeenCalled();
        expect(h.owner.resolveCorrection("original")).toBe(true);
      }
      expect(boundary.page.chatMessage).toBe(
        mode === "off" ? expected : `Existing field text. ${expected}`,
      );
      expect(boundary.writes).toHaveBeenCalledOnce();
      duplicateFinal();
      h.emit({ type: "close", reason: "completed" });
      await vi.advanceTimersByTimeAsync(0);
      expect(boundary.writes).toHaveBeenCalledOnce();
      expect(boundary.page.chatMessage).toBe(
        mode === "off" ? expected : `Existing field text. ${expected}`,
      );
    },
  );

  it.each([
    "profile",
    "profileless resolution",
    "profileless recovery scope",
    "credentials",
    "client",
    "physical session",
    "permission",
  ] as const)("retires prepared dictation when the live %s owner changes", async (change) => {
    const h = fixture();
    const boundary = lifecycleBoundary(h, change === "profileless recovery scope");
    await h.start();
    await h.finish("Tuesday sorry Wednesday");
    expect(h.owner.correctionReview?.canKeepOriginal).toBe(true);
    if (change === "physical session") {
      boundary.page.currentSessionId = "physical-two";
      boundary.update();
    } else if (change === "credentials") {
      Object.assign(boundary.gateway, {
        connectionRevision: boundary.gateway.connectionRevision + 1,
      });
      boundary.update();
    } else if (change === "client") {
      boundary.update({ client: h.createClient() });
    } else if (change === "profile" || change === "profileless resolution") {
      boundary.update({
        selfUser:
          change === "profile"
            ? { id: "bob", identity: { type: "profile", id: "profile-bob" } }
            : null,
      });
    } else {
      const hello = boundary.connected.hello!;
      boundary.update({
        hello: {
          ...hello,
          auth: {
            ...hello.auth,
            ...(change === "permission"
              ? { scopes: ["operator.read"] }
              : { recoveryScope: "account-two" }),
          },
        },
      });
    }
    expect(h.owner.correctionReview).toBeNull();
    boundary.page.currentSessionId = "physical-one";
    boundary.update(boundary.connected);
    expect(h.owner.resolveCorrection("correction")).toBe(false);
    expect(h.owner.resolveCorrection("original")).toBe(false);
    expect(boundary.page.chatMessage).toBe("Existing field text.");
    expect(boundary.writes).not.toHaveBeenCalled();
  });

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

  it.each(["original", "unavailable correction", "cancel", "literal"] as const)(
    "refuses another enabled capture until the previous recording resolves through %s",
    async (resolution) => {
      const h = fixture();
      const original = "Tuesday sorry Wednesday";
      h.owner.setLiteral(resolution === "literal");
      await h.start();
      const previous = h.owner.finishActive();
      expect(h.owner.correctionCommitRequired).toBe(true);
      expect(h.owner.startDirect()).toBe(false);
      expect(h.owner.handlePointerDown(new PointerEvent("pointerdown", { button: 0 }))).toBe(false);
      expect(
        h.request.mock.calls.filter(([method]) => method === "talk.session.create"),
      ).toHaveLength(1);

      h.final(original, 1);
      h.emit({ type: "close", reason: "completed" }, 1);
      expect(await previous).toBe(resolution === "literal");
      if (resolution !== "literal") {
        expect(h.owner.correctionReview).toMatchObject({
          canAccept: false,
          canKeepOriginal: true,
          result: { original, candidate: original, plan: null },
        });
        expect(h.owner.startDirect()).toBe(false);
        expect(h.owner.handlePointerDown(new PointerEvent("pointerdown", { button: 0 }))).toBe(
          false,
        );
        // A next-capture policy change cannot discard the unresolved recording.
        h.owner.update({ ...h.options, corrections: { mode: "off", locale: "en-US" } });
        expect(h.owner.startDirect()).toBe(false);
        h.owner.update(h.options);
        expect(h.onCommit).not.toHaveBeenCalled();
        if (resolution === "unavailable correction") {
          expect(h.owner.resolveCorrection("correction")).toBe(false);
          expect(h.owner.correctionCommitRequired).toBe(true);
          expect(h.owner.startDirect()).toBe(false);
        }
        expect(h.owner.resolveCorrection(resolution === "cancel" ? "cancel" : "original")).toBe(
          true,
        );
      }
      expect(h.owner.correctionCommitRequired).toBe(false);
      await h.start();
      h.final(original, 1);
      expect(await h.finish(original)).toBe(false);
      expect(h.owner.resolveCorrection("correction")).toBe(false);
      expect(h.owner.resolveCorrection("original")).toBe(true);
      const first = resolution === "cancel" ? "" : ` ${original}`;
      expect(h.draft()).toBe(`Existing field text.${first} ${original}`);
      expect(h.onCommit).toHaveBeenCalledTimes(resolution === "cancel" ? 1 : 2);
    },
  );

  it.each(["recording", "finalizing", "review"] as const)(
    "applies policy changes to the next capture while %s keeps its snapshot",
    async (phase) => {
      const h = fixture();
      const original = "Tuesday sorry Wednesday";
      await h.start();
      const stopped = phase === "finalizing" ? h.owner.finishActive() : null;
      if (phase === "review") {
        await h.finish(original);
      }
      h.owner.update({ ...h.options, corrections: { mode: "off", locale: "fr" } });
      if (stopped) {
        h.final(original);
        h.emit({ type: "close", reason: "completed" });
        await stopped;
      } else if (phase === "recording") {
        await h.finish(original);
      }
      expect(h.owner.correctionReview).toMatchObject({
        canAccept: false,
        canKeepOriginal: true,
        result: { original, candidate: original, status: "unavailable", plan: null },
      });
      expect(h.owner.resolveCorrection("correction")).toBe(false);
      expect(h.owner.resolveCorrection("original")).toBe(true);
      expect(h.draft()).toBe(`Existing field text. ${original}`);
      expect(h.owner.resolveCorrection("original")).toBe(false);

      await h.start();
      expect(await h.finish(original)).toBe(true);
      expect(h.owner.correctionReview).toBeNull();
      expect(h.draft()).toBe(`Existing field text. ${original} ${original}`);
      expect(h.onCommit).toHaveBeenCalledTimes(2);
    },
  );
});
