/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createSignal, flush } from "solid-js";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { ComposerDictationStatus } from "./components/chat-voice-activity.tsx";
import { DirectDictationView } from "./components/direct-dictation-view.tsx";
import type * as ComposerDictationModule from "./composer-dictation.ts";

const dictationHarness = vi.hoisted(() => {
  class Controller extends EventTarget {
    active = false;
    connecting = false;
    finalizing = false;
    transcript = "";

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

    constructor(private options: { onCommit: (transcript: string) => void }) {
      super();
      this.update(options);
      harness.controllers.push(this);
    }
    subscribe(listener: () => void) {
      this.addEventListener("change", listener);
      return () => this.removeEventListener("change", listener);
    }
    update(options: { onCommit: (transcript: string) => void }) {
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
    options: null as null | { onCommit: (transcript: string) => void },
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
  const control = new DirectDictationControl({
    textarea: { captureSelection, insertTranscript } as never,
    getClient: () => ({}) as never,
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
    expect(container.querySelector(".agent-chat__dictation-status")?.textContent).toContain(
      "Listening",
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
});
