/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createSignal, flush } from "solid-js";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { ComposerDictationStatus } from "./components/chat-voice-activity.tsx";
import { DirectDictationView } from "./components/direct-dictation-view.tsx";
import { placeComposerDictation } from "./composer-dictation-session.ts";
import type * as ComposerDictationModule from "./composer-dictation.ts";
import type { DictationDraftReceipt, DictationDraftSnapshot } from "./dictation-refinement.ts";

type DictationHarnessOptions = {
  onCommit: (transcript: string, late?: true) => DictationDraftReceipt | false | void;
  readDraft?: () => DictationDraftSnapshot | undefined;
  prepareSession?: () => Promise<string | undefined>;
};

const dictationHarness = vi.hoisted(() => {
  class Controller extends EventTarget {
    active = false;
    connecting = false;
    finalizing = false;
    transcribing = false;
    transcript = "";
    requiresCleanupReview = false;
    dismissCleanup = vi.fn();
    placeTranscript = placeComposerDictation;

    get locksComposer() {
      return this.active;
    }

    handleClick = vi.fn(() => {
      if (this.active) {
        void this.finishActive();
      }
    });
    startDirect = vi.fn(() => {
      this.active = true;
      this.dispatchEvent(new Event("change"));
      return true;
    });
    finishActive = vi.fn(async () => {
      this.options.onCommit("spoken task");
      this.active = false;
      this.dispatchEvent(new Event("change"));
      return true;
    });

    constructor(private options: DictationHarnessOptions) {
      super();
      this.update(options);
      harness.controllers.push(this);
    }
    subscribe(listener: () => void) {
      this.addEventListener("change", listener);
      return () => this.removeEventListener("change", listener);
    }
    update(options: DictationHarnessOptions) {
      this.options = options;
      harness.options = options;
    }
    dispose() {
      this.active = false;
    }
    handlePointerDown() {
      this.active = true;
    }
  }
  const harness = {
    options: null as null | DictationHarnessOptions,
    controllers: [] as Controller[],
  };
  return Object.assign(harness, { Controller });
});

vi.mock("./composer-dictation.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof ComposerDictationModule>()),
  ComposerDictationOwner: dictationHarness.Controller,
}));

vi.mock("./composer-microphone-picker.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./composer-microphone-picker.ts")>()),
  ComposerMicrophoneOwner: class {
    devices = [];
    loading = false;
    open = false;
    issue = null;
    realtimeStatus = "ready";
    dictationStatus = "ready";
    subscribe() {
      return () => {};
    }
    syncCatalog() {}
    handleOpen() {}
    handleClose() {}
    dispose() {}
  },
}));

import {
  createDirectDictationTextarea,
  DirectDictationControl,
} from "./composer-direct-dictation.ts";

function fixture(
  options: Partial<ConstructorParameters<typeof DirectDictationControl>[0]> = {},
  text = "spoken task",
) {
  const captureSelection = vi.fn();
  const insertTranscript = vi.fn(() => text);
  const onMessage = vi.fn();
  const onError = vi.fn();
  const onSubmit = vi.fn();
  const client = {};
  const control = new DirectDictationControl({
    textarea: { captureSelection, insertTranscript } as never,
    getClient: () => client as never,
    isConnected: () => true,
    canCommit: () => true,
    onMessage,
    onError,
    onSubmit,
    ...options,
  });
  return { control, captureSelection, insertTranscript, onMessage, onError, onSubmit };
}

function mountControl(control: DirectDictationControl, showStatus = false) {
  const [view, setView] = createSignal({ owner: "agent-a" });
  const mounted = mountSolid(() => (
    <>
      {showStatus && (
        <ComposerDictationStatus
          readDictation={() => {
            view();
            return control.dictation;
          }}
        />
      )}
      <DirectDictationView
        control={control}
        ownerKey={view().owner}
        idleLabel="Dictate"
        renderRevision={view()}
      />
    </>
  ));
  return {
    ...mounted,
    update: (owner = view().owner) => {
      setView({ owner });
      flush();
    },
  };
}

describe("DirectDictationControl", () => {
  beforeEach(() => {
    dictationHarness.options = null;
    dictationHarness.controllers = [];
  });

  it("drops a final transcript when cloud placement claims the draft in flight", () => {
    let canCommit = true;
    const { control, insertTranscript, onMessage } = fixture({ canCommit: () => canCommit });

    control.prepare("agent-a");
    canCommit = false;
    dictationHarness.options?.onCommit("spoken task");

    expect(insertTranscript).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("starts canonical dictation from a plain microphone click", () => {
    const { control, captureSelection, onError } = fixture();
    const { container } = mountControl(control);
    const microphone = container.querySelector<HTMLButtonElement>(".chat-send-btn--voice");

    microphone?.click();

    expect(microphone).not.toBeNull();
    expect(microphone?.classList.contains("chat-send-btn--hold-enabled")).toBe(false);
    expect(
      (microphone?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)
        ?.content,
    ).toBe("Dictate");
    expect(captureSelection).toHaveBeenCalledOnce();
    expect(dictationHarness.controllers[0]?.startDirect).toHaveBeenCalledOnce();
    expect(dictationHarness.controllers[0]?.handleClick).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    control.dispose();
  });

  it("keeps text from Stop and submits only after the Send check commits", async () => {
    const onMessage = vi.fn();
    const onSubmit = vi.fn();
    const { control } = fixture({
      textarea: {
        captureSelection: vi.fn(),
        insertTranscript: vi.fn(() => "draft spoken task"),
        previewTranscript: vi.fn(() => "draft spoken"),
      } as never,
      onMessage,
      onSubmit,
    });
    control.prepare("agent-a");
    const controller = expectDefined(dictationHarness.controllers[0], "dictation controller");

    controller.active = true;
    controller.transcript = "spoken";
    expect(control.previewDraft()).toBe("draft spoken");
    const { container, update } = mountControl(control, true);
    // The phase view is a lazy chunk that loads with the first dictation.
    await vi.waitFor(() =>
      expect(container.querySelector(".agent-chat__dictation-status")?.textContent).toContain(
        "Listening",
      ),
    );
    expect(container.querySelector(".agent-chat__dictation-phase--listening")).not.toBeNull();
    container.querySelector<HTMLButtonElement>(".chat-send-btn--dictating")?.click();
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith("draft spoken task"));
    expect(onSubmit).not.toHaveBeenCalled();

    controller.active = true;
    controller.finalizing = true;
    update();
    expect(container.querySelector(".agent-chat__dictation-phase--listening")).toBeNull();
    const stop = container.querySelector<HTMLButtonElement>(".chat-send-btn--dictating");
    const send = container.querySelector<HTMLButtonElement>(".chat-send-btn--dictation-commit");
    expect(stop?.querySelector("rect")).not.toBeNull();
    expect(send?.querySelector("path")?.getAttribute("d")).toBe("M12 19V5m-7 7 7-7 7 7");
    controller.finalizing = false;
    container.querySelector<HTMLButtonElement>(".chat-send-btn--dictation-commit")?.click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(controller.finishActive).toHaveBeenCalledTimes(2);
  });

  it("keeps the lazy status visible after Stop until transcription settles", async () => {
    const { control } = fixture();
    control.prepare("agent-a");
    const controller = expectDefined(dictationHarness.controllers[0], "dictation owner");
    const { container, update } = mountControl(control, true);
    controller.active = true;
    controller.transcribing = true;
    update();
    await vi.waitFor(() =>
      expect(container.querySelector(".agent-chat__dictation-phase")?.textContent).toContain(
        "Listening",
      ),
    );
    controller.active = false;
    update();
    await vi.waitFor(() =>
      expect(container.querySelector(".agent-chat__dictation-phase")?.textContent).toMatch(
        /Finishing|Transcribing/,
      ),
    );
    expect(container.querySelector('[data-status="thinking"]')).not.toBeNull();
    controller.transcribing = false;
    update();
    expect(container.querySelector(".agent-chat__dictation-status")).toBeNull();
  });

  it("does not submit a replacement route after finishing the previous draft's dictation", async () => {
    const textarea = createDirectDictationTextarea(() => null);
    const client = createTestGatewayClient(async () => ({}));
    const onSubmit = vi.fn();
    const { control } = fixture({
      textarea,
      getClient: () => client,
      onSubmit,
    });
    onTestFinished(() => control.dispose());
    const { container, update } = mountControl(control);
    const dictation = expectDefined(
      dictationHarness.controllers[0],
      "initial dictation controller",
    );
    dictation.active = true;
    update();
    const finishing = createDeferred<boolean>();
    dictation.finishActive.mockReturnValueOnce(finishing.promise);
    container.querySelector<HTMLButtonElement>(".chat-send-btn--dictation-commit")?.click();
    expect(dictation.finishActive).toHaveBeenCalledOnce();

    update("agent-b");
    finishing.resolve(true);
    await finishing.promise;
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("cancels active dictation and drops its late transcript when the route owner changes", () => {
    const { control, insertTranscript, onMessage } = fixture({}, "route B draft");

    control.prepare("agent-a");
    const routeAController = dictationHarness.controllers[0];
    routeAController?.handlePointerDown();
    const routeACommit = dictationHarness.options?.onCommit;

    control.prepare("agent-a");
    expect(dictationHarness.controllers).toHaveLength(1);
    expect(routeAController?.active).toBe(true);

    control.prepare("agent-b");
    control.prepare("agent-a");
    routeACommit?.("late route A transcript");

    expect(routeAController?.active).toBe(false);
    expect(dictationHarness.controllers).toHaveLength(3);
    expect(insertTranscript).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  function receiptFixture(maxLength = -1) {
    const target = document.createElement("textarea");
    if (maxLength >= 0) {
      target.maxLength = maxLength;
    }
    target.value = "before same after same";
    target.setSelectionRange(7, 11);
    document.body.append(target);
    const textarea = createDirectDictationTextarea(() => target);
    const f = fixture({ textarea });
    const presentation = f.control.prepare("agent-a");
    presentation.voice.onDirectDictationStart();
    const receipt = dictationHarness.options?.onCommit("clean", true);
    onTestFinished(() => {
      f.control.dispose();
      target.remove();
    });
    return {
      ...f,
      target,
      textarea,
      receipt: expectDefined(receipt || undefined, "insertion receipt"),
    };
  }

  it("restores only the selected insertion using its original placement", () => {
    const f = receiptFixture();
    expect(f.target.value).toBe("before clean after same");
    expect(f.receipt.isCurrent()).toBe(true);
    expect(f.receipt.restore("um same")).toBe(true);
    expect(f.target.value).toBe("before um same after same");
    expect(f.onMessage.mock.calls.map(([message]) => message)).toEqual([
      "before clean after same",
      "before um same after same",
    ]);
    expect(f.receipt.restore("another value")).toBe(false);
  });

  it("retires restoration after an edit and native undo return to the same text", () => {
    const f = receiptFixture();
    const applied = f.textarea.readDraft();
    f.target.value = "changed";
    f.target.dispatchEvent(new Event("input"));
    f.target.value = "before clean after same";
    f.target.dispatchEvent(new Event("input"));
    expect(f.textarea.readDraft()?.revision).toBeGreaterThan(applied?.revision ?? 0);
    expect(f.receipt.restore("um same")).toBe(false);
    expect(f.target.value).toBe("before clean after same");
    expect(f.onMessage).toHaveBeenCalledOnce();
  });

  it.each(["scope", "submit", "dispose"])("retires receipts at the %s boundary", (boundary) => {
    const f = receiptFixture();
    if (boundary === "scope") {
      f.control.prepare("agent-b");
      f.control.prepare("agent-a");
    } else if (boundary === "submit") {
      f.control.prepare("agent-a").onSubmit();
    } else {
      f.control.dispose();
    }
    expect(f.receipt.restore("um same")).toBe(false);
    expect(f.target.value).toBe("before clean after same");
    expect(f.onMessage).toHaveBeenCalledOnce();
  });

  it("keeps the accepted draft when the original insertion would exceed its limit", () => {
    const f = receiptFixture();
    f.target.maxLength = f.target.value.length;
    expect(f.receipt.restore("um same")).toBe(false);
    expect(f.receipt.isCurrent()).toBe(false);
    expect(f.target.value).toBe("before clean after same");
    expect(f.onMessage).toHaveBeenCalledOnce();
  });

  it("refuses to clip the original when the limit was already set before insertion", () => {
    const f = receiptFixture(23);
    expect(f.target.value).toBe("before clean after same");
    expect(f.receipt.restore("um same")).toBe(false);
    expect(f.receipt.isCurrent()).toBe(false);
    expect(f.target.value).toBe("before clean after same");
    expect(f.onMessage).toHaveBeenCalledExactlyOnceWith("before clean after same");
  });

  it("refuses an oversized conservative insertion before writing and accepts the exact limit", () => {
    const target = document.createElement("textarea");
    target.value = "prefix";
    target.maxLength = 9;
    target.setSelectionRange(6, 6);
    document.body.append(target);
    const textarea = createDirectDictationTextarea(() => target);
    const f = fixture({ textarea });
    f.control.prepare("agent-a").voice.onDirectDictationStart();
    expectDefined(dictationHarness.controllers[0], "dictation owner").requiresCleanupReview = true;
    onTestFinished(() => {
      f.control.dispose();
      target.remove();
    });
    const revision = textarea.readDraft()?.revision;
    expect(dictationHarness.options?.onCommit("fit", true)).toBe(false);
    expect(target.value).toBe("prefix");
    expect(textarea.readDraft()?.revision).toBe(revision);
    expect(f.onMessage).not.toHaveBeenCalled();
    target.maxLength = 10;
    expect(dictationHarness.options?.onCommit("fit", true)).toBeTruthy();
    expect(target.value).toBe("prefix fit");
    expect(f.onMessage).toHaveBeenCalledExactlyOnceWith("prefix fit");
  });
});

it.each([
  { draft: "ask me", start: 6, end: 6, limit: 8, spoken: "🌱", expected: "ask me " },
  {
    draft: "ask basil about peas?",
    start: 4,
    end: 9,
    limit: 21,
    spoken: "🌱 basil",
    expected: "ask 🌱 ba about peas?",
  },
])(
  "fits the dictated replacement into the available space in '$draft'",
  ({ draft, start, end, limit, spoken, expected }) => {
    const target = document.createElement("textarea");
    target.maxLength = limit;
    target.value = draft;
    target.setSelectionRange(start, end);
    const editor = createDirectDictationTextarea(() => target);
    editor.captureSelection();
    expect(editor.previewTranscript(placeComposerDictation, spoken)).toBe(expected);
    expect(editor.insertTranscript(placeComposerDictation, spoken)).toBe(expected);
    expect(target.value).toBe(expected);
  },
);

it("keeps edits made after Stop when a late replacement reaches the limit", () => {
  const target = document.createElement("textarea");
  target.maxLength = 12;
  target.value = "old";
  const editor = createDirectDictationTextarea(() => target);
  editor.captureSelection();
  target.value = "pick a pear";
  target.setSelectionRange(5, 6);
  expect(editor.insertTranscript(placeComposerDictation, "ripe", true)).toBe("pick ri pear");
});

it("keeps a newer preview provisional when earlier dictation text arrives", () => {
  const target = document.createElement("textarea");
  target.value = "base";
  target.setSelectionRange(4, 4);
  const editor = createDirectDictationTextarea(() => target);
  editor.captureSelection();
  target.value = editor.previewTranscript(placeComposerDictation, "new preview") ?? "";
  expect(editor.insertTranscript(placeComposerDictation, "first", true, true)).toBe("base first");
  target.value = editor.previewTranscript(placeComposerDictation, "new preview") ?? "";
  expect(target.value).toBe("base first new preview");
  expect(editor.insertTranscript(placeComposerDictation, "second", true, true)).toBe(
    "base first second",
  );
  expect(editor.previewTranscript(placeComposerDictation, "new preview")).toBe(
    "base first second new preview",
  );
  target.value = "base first second";
  expect(editor.insertTranscript(placeComposerDictation, "final words", true)).toBe(
    "base first second final words",
  );
});
