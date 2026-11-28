// @vitest-environment jsdom
import { within } from "@solidjs/testing-library";
import { createComponent, flush } from "solid-js";
import { afterEach, assert, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { createComposerDraftSource } from "../../lib/chat/composer-draft-changes.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createComposerContainer,
  createComposerProps,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
import { ComposerDictationSendAction } from "./components/chat-composer-controls.tsx";
import { getChatComposerState, resetChatComposerState } from "./components/chat-composer-state.ts";
import { DictationRefinementView } from "./components/composer-dictation-refinement-view.tsx";
import { ComposerDictationOwner } from "./composer-dictation.ts";
import { audioFixture, MockDictationAudioContext } from "./talk/input.test-support.ts";

type OwnerOptions = ConstructorParameters<typeof ComposerDictationOwner>[0];
type Listener = (event: GatewayEventFrame) => void;
const owners: ComposerDictationOwner[] = [];

class PrimerAudio extends EventTarget {
  readonly play = vi.fn(async () => undefined);
  readonly pause = vi.fn();
  readonly removeAttribute = vi.fn();
  readonly load = vi.fn();
}

// Only browser media and Gateway I/O are fixtures. Capture finality, draft ownership,
// ordered refinement, validation, and preview acceptance all use production code.
function fixture() {
  const listeners = new Set<Listener>();
  const media = audioFixture();
  const state = { revision: 0, draft: "Existing draft.", connectionGeneration: 1, authority: {} };
  let captures = 0;
  let sequence = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "talk.catalog") {
      return {
        transcription: { ready: true, providers: [] },
        realtime: { ready: false, providers: [] },
        speech: { providers: [] },
        modes: [],
        transports: [],
        brains: [],
      };
    }
    if (method === "talk.config") {
      return { config: { talk: {} } };
    }
    if (method === "talk.session.create") {
      const id = `capture-${++captures}`;
      return {
        sessionId: id,
        transcriptionSessionId: id,
        audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
      };
    }
    return { ok: true };
  });
  const createClient = () => {
    // SAFETY: this external transport fixture implements every client operation used by capture.
    return {
      request,
      get connectionGeneration() {
        return state.connectionGeneration;
      },
      get auth() {
        return state.authority;
      },
      addEventListener: (listener: Listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as GatewayBrowserClient;
  };
  vi.stubGlobal("navigator", {
    language: "en-US",
    mediaDevices: { getUserMedia: vi.fn(async () => media.stream) },
  });
  const onCommit = vi.fn((text: string) => {
    state.draft += ` ${text}`;
    state.revision += 1;
  });
  const options: OwnerOptions = {
    client: createClient(),
    connected: true,
    enabled: true,
    realtimeTalkActive: false,
    draftKey: "draft-a",
    accountId: "account-a",
    refinementAvailable: true,
    getDraftRevision: () => state.revision,
    getDraftText: () => state.draft,
    onCommit,
    onError: vi.fn(),
  };
  const owner = new ComposerDictationOwner(options);
  owners.push(owner);
  const emit = (type: "partial" | "transcript" | "close", text = "", capture = captures) => {
    const id = `capture-${capture}`;
    sequence += 1;
    const frame: GatewayEventFrame = {
      type: "event",
      event: "talk.event",
      payload: {
        transcriptionSessionId: id,
        type,
        text,
        ...(type === "transcript" ? { final: true } : {}),
        ...(type === "close" ? { reason: "completed" } : {}),
        talkEvent: {
          id: `${id}:${sequence}`,
          sessionId: id,
          seq: sequence,
          turnId: "turn-1",
          type: {
            partial: "transcript.delta",
            transcript: "transcript.done",
            close: "session.closed",
          }[type],
        },
      },
    };
    for (const listener of listeners) {
      listener(frame);
    }
  };
  const start = async () => {
    expect(owner.startDirect()).toBe(true);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.active).toBe(true);
    expect(owner.connecting).toBe(false);
  };
  const complete = async (text: string) => {
    const finished = owner.finishActive();
    emit("transcript", text);
    emit("close");
    return await finished;
  };
  return {
    owner,
    state,
    options,
    request,
    media,
    listeners,
    onCommit,
    emit,
    start,
    complete,
    createClient,
  };
}

function mountReview(owner: ComposerDictationOwner) {
  return mountSolid(() => {
    const projection = projectOwner(owner, (value) => value);
    return createComponent(DictationRefinementView, { readDictation: projection.read });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", MockDictationAudioContext);
  vi.stubGlobal("Audio", PrimerAudio);
});

afterEach(async () => {
  for (const owner of owners.splice(0)) {
    owner.dispose();
  }
  cleanupSolid();
  resetChatComposerState();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dictation refinement at the composer boundary", () => {
  it("announces cancellation when the recording owner cancels the same capture twice", async () => {
    const h = fixture();
    h.owner.setRefinementEnabled(true);
    const view = mountReview(h.owner);
    await h.start();
    view.getByRole("button", { name: "Cancel text refinement" }).click();
    flush();
    expect(h.media.track.stop).toHaveBeenCalledOnce();
    expect(view.getByRole("status").textContent).toContain("Text refinement cancelled.");
    expect(h.owner.refinement?.pending).toBe(false);
    expect(h.onCommit).not.toHaveBeenCalled();
  });

  it.each(["unchanged", "restored before flush"] as const)(
    "uses actual main-composer draft ownership when its source is %s",
    async (draftChange) => {
      const h = fixture();
      const source = createComposerDraftSource(() => ({
        draft: h.state.draft,
        mentions: [],
        attachments: [],
        pendingAttachmentReads: 0,
      }));
      const onDraftChange = vi.fn((value: string) => {
        h.state.draft = value;
        source.publish();
      });
      const props = createComposerProps({
        gatewayClient: h.options.client,
        // The main composer admits its voice controls only for a Talk-capable surface.
        onToggleRealtimeTalk: vi.fn(),
        composerHoldToRecord: true,
        draft: h.state.draft,
        draftSource: source,
        getDraft: () => h.state.draft,
        onDraftChange,
      });
      const container = document.body.appendChild(createComposerContainer());
      onTestFinished(() => container.remove());
      renderComposerInto(container, props);
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
      flush();
      const state = getChatComposerState(props.paneId);
      const dictation = state.dictation;
      assert.isNotNull(dictation);
      const mobileControls = container.querySelector<HTMLElement>(".chat-mobile-dictation-action");
      assert.isNotNull(mobileControls);
      within(container).getByRole("button", { name: "Dictation text options" }).click();
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
      flush();
      within(container)
        .getByRole("checkbox", { name: "Review dictated text before inserting" })
        .click();
      flush();
      within(mobileControls)
        .getByRole("button", { name: /^Dictation$/u })
        .click();
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
      flush();
      expect(dictation.active).toBe(true);
      h.emit("partial", "Do not");
      flush();
      expect(h.state.draft).toBe("Existing draft.");
      expect(onDraftChange).not.toHaveBeenCalled();
      const finish = container.querySelector<HTMLButtonElement>(".chat-send-btn--dictation-commit");
      assert.isNotNull(finish);
      finish.click();
      h.emit("transcript", "Do not delete customer_id.");
      h.emit("close");
      await vi.advanceTimersByTimeAsync(0);
      flush();
      expect(within(container).getByLabelText("Text preview")).toHaveProperty(
        "value",
        "Do not delete customer_id.",
      );
      const accept = within(container).getByRole("button", { name: "Use reviewed text" });
      if (draftChange === "restored before flush") {
        // Programmatic owner notifications can restore the same value in one render batch.
        // No input event, explicit invalidation, revision write, await, or Solid flush intervenes.
        h.state.draft = "A programmatically replaced draft.";
        source.publish();
        h.state.draft = "Existing draft.";
        source.publish();
      }
      accept.click();
      expect(h.state.draft).toBe(
        draftChange === "unchanged"
          ? "Existing draft. Do not delete customer_id."
          : "Existing draft.",
      );
      expect(onDraftChange).toHaveBeenCalledTimes(draftChange === "unchanged" ? 1 : 0);
      expect(props.onSend).not.toHaveBeenCalled();
      expect(props.onToggleRealtimeTalk).not.toHaveBeenCalled();
      expect(h.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
      flush();
      expect(within(container).queryByLabelText("Text preview")).toBeNull();
    },
  );

  it("preserves baseline dictation when a destination withdraws review support", async () => {
    const h = fixture();
    h.owner.setRefinementEnabled(true);
    await h.start();
    h.owner.update({ ...h.options, refinementAvailable: false });
    expect(h.owner.refinementEnabled).toBe(false);
    expect(h.owner.refinement?.pending).toBe(false);
    h.owner.setRefinementEnabled(true);
    expect(h.owner.refinementEnabled).toBe(false);
    await h.start();
    expect(await h.complete("Baseline recovery.")).toBe(true);
    expect(h.onCommit).toHaveBeenCalledExactlyOnceWith("Baseline recovery.", true);
  });

  it("keeps refinement off by default and preserves baseline draft transcription", async () => {
    const h = fixture();
    await h.start();
    h.emit("partial", "Provisional baseline caption");
    expect(h.owner.transcript).toBe("Provisional baseline caption");
    expect(await h.complete("Final baseline text.")).toBe(true);
    expect(h.onCommit).toHaveBeenCalledExactlyOnceWith("Final baseline text.", true);
    expect(h.owner.refinement).toBeUndefined();
  });

  it("waits through the realtime relay's five-second drain before offering explicit acceptance", async () => {
    const h = fixture();
    h.owner.setRefinementEnabled(true);
    await h.start();
    h.emit("partial", "Do not");
    expect(h.owner.transcript).toBe("");
    expect(h.owner.provisionalTranscript).toBe("Do not");
    const finished = h.owner.finishActive();
    expect(h.media.track.stop).toHaveBeenCalledOnce();
    expect(h.owner.locksComposer).toBe(false);
    h.emit("transcript", "Do not delete customer_id.");
    // The close RPC can acknowledge Stop while the relay is still draining provider events.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.owner.refinement?.phase).toBe("finishing");
    h.emit("close");
    await expect(finished).resolves.toBe(false);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.state.draft).toBe("Existing draft.");
    expect(h.owner.refinement?.result).toMatchObject({
      status: "refined",
      text: "Do not delete customer_id.",
      rawText: "Do not delete customer_id.",
    });
    expect(h.owner.refinement?.accept("candidate")).toBe(true);
    expect(h.owner.refinement?.accept("candidate")).toBe(false);
    expect(h.onCommit).toHaveBeenCalledExactlyOnceWith("Do not delete customer_id.", true);
    expect(h.request.mock.calls.map(([method]) => method)).toEqual([
      "talk.session.create",
      "talk.session.close",
    ]);
  });

  it.each(["finishing", "ready"] as const)(
    "keeps manual edits when old dictation is %s",
    async (when) => {
      const h = fixture();
      h.owner.setRefinementEnabled(true);
      await h.start();
      const finished = h.owner.finishActive();
      if (when === "ready") {
        h.emit("transcript", "Older dictated text.");
        h.emit("close");
        await finished;
      }
      h.state.revision += 1;
      h.state.draft = "The user's newer edit.";
      if (when === "finishing") {
        h.owner.invalidateRefinement();
      }
      h.emit("transcript", "Older dictated text.");
      h.emit("close");
      await finished;
      // A ready result must recheck the draft even before its owner receives reconciliation.
      expect(h.owner.refinement?.accept("raw")).toBe(false);
      expect(h.owner.refinement?.result).toBeUndefined();
      expect(h.onCommit).not.toHaveBeenCalled();
      expect(h.state.draft).toBe("The user's newer edit.");
    },
  );

  it.each([
    "target",
    "account",
    "connection",
    "connection generation",
    "authority",
    "permission",
    "locale",
  ] as const)("retires a finishing capture when its %s changes", async (change) => {
    const h = fixture();
    h.owner.setRefinementEnabled(true);
    await h.start();
    const finished = h.owner.finishActive();
    if (change === "connection generation") {
      h.state.connectionGeneration += 1;
    }
    if (change === "authority") {
      h.state.authority = {};
    }
    if (change === "locale") {
      vi.stubGlobal("navigator", { mediaDevices: navigator.mediaDevices, language: "ar" });
    }
    h.owner.update({
      ...h.options,
      ...(change === "connection" ? { client: h.createClient() } : {}),
      ...(change === "target" ? { draftKey: "draft-b" } : {}),
      ...(change === "account" ? { accountId: "account-b" } : {}),
      ...(change === "permission" ? { enabled: false } : {}),
    });
    h.emit("transcript", "An ineligible late result.");
    h.emit("close");
    await finished;
    expect(h.owner.refinement?.result).toBeUndefined();
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
  });

  it("supersedes a finishing recording without replaying it into a new capture", async () => {
    const h = fixture();
    h.owner.setRefinementEnabled(true);
    await h.start();
    const first = h.owner.finishActive();
    await h.start();
    h.emit("transcript", "Stale first capture.", 1);
    h.emit("close", "", 1);
    await first;
    await h.complete("Current second capture.");
    expect(h.owner.refinement?.result?.text).toBe("Current second capture.");
    expect(h.owner.refinement?.accept("candidate")).toBe(true);
    expect(h.onCommit).toHaveBeenCalledExactlyOnceWith("Current second capture.", true);
  });

  it("uses Escape to cancel finishing and rejects late final events", async () => {
    const h = fixture();
    h.owner.setRefinementEnabled(true);
    await h.start();
    const finished = h.owner.finishActive();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await finished;
    h.emit("transcript", "Late text must stay cancelled.");
    h.emit("close");
    expect(h.owner.refinement?.phase).toBe("cancelled");
    expect(h.owner.refinement?.result).toBeUndefined();
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
  });

  it("offers incomplete captions only for manual recovery after the hard deadline", async () => {
    const h = fixture();
    h.owner.setRefinementEnabled(true);
    const view = mountReview(h.owner);
    await h.start();
    h.emit("partial", "Do not");
    const finished = h.owner.finishActive();
    await vi.advanceTimersByTimeAsync(10_000);
    await finished;
    flush();
    expect(h.owner.refinement?.phase).toBe("unavailable");
    expect(h.owner.refinement?.incompleteCaption).toBe("Do not");
    expect(h.owner.refinement?.accept("raw")).toBe(false);
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(view.getByLabelText("Incomplete caption — manual recovery only")).toHaveProperty(
      "value",
      "Do not",
    );
    expect(view.queryByRole("button", { name: "Keep raw transcript" })).toBeNull();
    expect(view.queryByRole("button", { name: "Use reviewed text" })).toBeNull();
  });

  it("offers an accessible opt-in and stable status while preserving literal text for explicit review", async () => {
    const h = fixture();
    const view = mountReview(h.owner);
    view.getByText("Dictation text options").click();
    const checkbox = view.getByRole("checkbox", { name: "Review dictated text before inserting" });
    expect(checkbox).toHaveProperty("checked", false);
    checkbox.click();
    expect(h.owner.refinementEnabled).toBe(true);
    flush();
    const status = view.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    await h.start();
    h.emit("partial", "لا تحذف");
    flush();
    expect(checkbox).toHaveProperty("disabled", true);
    h.owner.setRefinementEnabled(false);
    expect(status.textContent).not.toContain("لا تحذف");
    const caption = view.getByLabelText("Provisional caption");
    expect(caption.getAttribute("aria-live")).toBe("off");
    expect(caption).toHaveProperty("readOnly", true);
    const finished = h.owner.finishActive();
    flush();
    expect(status.textContent).toContain("The microphone is off.");
    const literal = 'لا تحذف customer_id أو -12 mg. "Keep This." /tmp/الملف';
    h.emit("transcript", literal);
    h.emit("close");
    await finished;
    flush();
    expect(view.getByRole("status")).toBe(status);
    expect(checkbox).toHaveProperty("disabled", true);
    expect(status.textContent).toContain("Nothing has been sent.");
    view.getByText("Inspect changes").click();
    for (const label of ["Text preview", "Original finalized transcript"]) {
      const text = view.getByLabelText(label);
      expect(text).toHaveProperty("value", literal);
      expect(text).toHaveProperty("readOnly", true);
      expect(text.getAttribute("dir")).toBe("auto");
    }
    expect(h.onCommit).not.toHaveBeenCalled();
    view.getByRole("button", { name: "Keep raw transcript" }).click();
    flush();
    expect(checkbox).toHaveProperty("disabled", false);
    expect(h.onCommit).toHaveBeenCalledExactlyOnceWith(literal, true);
    expect(view.queryByRole("button", { name: "Use reviewed text" })).toBeNull();
  });

  it.each(["partial", "final"] as const)(
    "rejects an oversized %s without presenting clipped text",
    async (kind) => {
      const h = fixture();
      h.owner.setRefinementEnabled(true);
      const view = mountReview(h.owner);
      await h.start();
      const text = "Do not ".repeat(5_000);
      const finished = h.owner.finishActive();
      h.emit(kind === "final" ? "transcript" : "partial", text);
      h.emit("close");
      await finished;
      flush();
      expect(h.owner.refinement?.captionLimitExceeded).toBe(true);
      expect(view.getByRole("status").textContent).toContain("exceeds the text review limit");
      expect(view.queryByRole("textbox")).toBeNull();
      expect(h.owner.refinement?.accept("raw")).toBe(false);
      expect(h.onCommit).not.toHaveBeenCalled();
    },
  );

  it.each(["deadline", "span"])("offers raw fallback after %s", async (reason) => {
    const h = fixture();
    h.owner.setRefinementEnabled(true);
    await h.start();
    const finished = h.owner.finishActive();
    const raw = reason === "deadline" ? "Keep -12 mg." : "id_x ".repeat(257).trim();
    h.emit("transcript", raw);
    h.emit("close");
    // A main-thread delay after terminal STT consumes the refinement budget.
    if (reason === "deadline") {
      vi.setSystemTime(Date.now() + 2_501);
    }
    await finished;
    expect(h.owner.refinement?.result).toMatchObject({
      status: "raw-fallback",
      text: raw,
      warnings: [reason === "deadline" ? "deadline" : "disabled"],
    });
    expect(h.onCommit).not.toHaveBeenCalled();
    expect(h.owner.refinement?.accept("raw")).toBe(true);
  });

  it("does not send after the actual dictation send control finishes a review-required capture", async () => {
    const h = fixture();
    h.owner.setRefinementEnabled(true);
    await h.start();
    const onSend = vi.fn();
    const view = mountSolid(() => {
      const owner = projectOwner(h.owner, (value) => value);
      return createComponent(ComposerDictationSendAction, { readDictation: owner.read, onSend });
    });
    view.getByRole("button").click();
    h.emit("transcript", "Review this before sending.");
    h.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.owner.refinement?.result?.text).toBe("Review this before sending.");
    expect(onSend).not.toHaveBeenCalled();
    expect(h.onCommit).not.toHaveBeenCalled();
  });
});
