/* @vitest-environment jsdom */

import { html, render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
const client = {} as never;
const pickerHarness = vi.hoisted(() => ({ sync: vi.fn(), prepare: vi.fn(), open: vi.fn() }));

const dictationHarness = vi.hoisted(() => ({
  options: null as null | {
    onCommit: (transcript: string) => void;
    onStateChange?: () => void;
  },
  controllers: [] as Array<{
    active: boolean;
    finalizing: boolean;
    transcript: string;
    finishActive: ReturnType<typeof vi.fn>;
    handleClick: ReturnType<typeof vi.fn>;
    handlePointerDown: () => void;
    startDirect: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../chat/composer-dictation.ts", () => ({
  ComposerDictationController: class {
    active = false;
    connecting = false;
    finalizing = false;
    transcript = "";
    private options: { onCommit: (transcript: string) => void; onStateChange?: () => void };

    get locksComposer() {
      return this.active;
    }

    handleClick = vi.fn();
    startDirect = vi.fn(() => {
      this.active = true;
      this.options.onStateChange?.();
      return true;
    });
    finishActive = vi.fn(async () => {
      this.options.onCommit("spoken task");
      this.active = false;
      this.options.onStateChange?.();
      return true;
    });

    constructor(options: { onCommit: (transcript: string) => void; onStateChange?: () => void }) {
      this.options = options;
      dictationHarness.options = options;
      dictationHarness.controllers.push(this);
    }
    update(options: { onCommit: (transcript: string) => void; onStateChange?: () => void }) {
      this.options = options;
      dictationHarness.options = options;
    }
    dispose() {
      this.active = false;
    }
    handlePointerDown() {
      this.active = true;
    }
  },
}));

vi.mock("../chat/composer-microphone-picker.ts", () => ({
  ComposerMicrophonePicker: class {
    devices = [];
    loading = false;
    open = false;
    issue = null;
    realtimeStatus = "ready";
    dictationStatus = "ready";
    syncCatalog = pickerHarness.sync;
    prepareDictation = pickerHarness.prepare;
    handleOpen = pickerHarness.open;
    handleClose() {}
    dispose() {}
  },
}));

import { NewSessionDictationControl } from "./composer-dictation-control.ts";

describe("NewSessionDictationControl", () => {
  beforeEach(() => {
    dictationHarness.options = null;
    dictationHarness.controllers = [];
    pickerHarness.sync.mockClear();
    pickerHarness.open.mockClear();
    pickerHarness.prepare.mockReset().mockResolvedValue(true);
  });

  it.each(["escape", "blur", "dispose", "route", "disconnect", "submit", "superseded"] as const)(
    "never starts capture after %s while catalog preparation is pending",
    async (transition) => {
      const pending = createDeferred<boolean | null>();
      pickerHarness.prepare.mockReturnValue(pending.promise);
      let connected = true;
      let canCommit = true;
      const control = new NewSessionDictationControl({
        textarea: { captureSelection: vi.fn(), insertTranscript: vi.fn() } as never,
        getClient: () => client,
        isConnected: () => connected,
        canCommit: () => canCommit,
        onMessage: vi.fn(),
        onError: vi.fn(),
        onSubmit: vi.fn(),
        requestUpdate: vi.fn(),
      });
      const container = document.createElement("div");
      render(control.render("a"), container);
      container.querySelector<HTMLButtonElement>(".chat-send-btn--voice")?.click();
      const dictation = dictationHarness.controllers[0];
      expect(pickerHarness.prepare).toHaveBeenCalledOnce();
      expect(dictation?.startDirect).not.toHaveBeenCalled();
      const status = document.createElement("div");
      render(control.renderStatus(), status);
      expect(status.querySelector('[role="status"] .btn__spinner')).not.toBeNull();
      if (transition === "escape") {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      }
      if (transition === "blur") {
        window.dispatchEvent(new Event("blur"));
      }
      if (transition === "dispose") {
        control.dispose();
      }
      if (transition === "route") {
        control.render("b");
        control.render("a");
      }
      if (transition === "disconnect") {
        connected = false;
        control.render("a");
        connected = true;
        control.render("a");
      }
      if (transition === "submit") {
        canCommit = false;
        control.render("a");
      }
      pending.resolve(transition === "superseded" ? null : true);
      await pending.promise;
      await Promise.resolve();
      expect(dictation?.startDirect).not.toHaveBeenCalled();
      expect(pickerHarness.open).not.toHaveBeenCalled();
      control.dispose();
    },
  );

  it("shows microphone setup instead of capturing when readiness is unavailable", async () => {
    pickerHarness.prepare.mockResolvedValue(false);
    const control = new NewSessionDictationControl({
      textarea: { captureSelection: vi.fn(), insertTranscript: vi.fn() } as never,
      getClient: () => client,
      isConnected: () => true,
      canCommit: () => true,
      onMessage: vi.fn(),
      onError: vi.fn(),
      onSubmit: vi.fn(),
      requestUpdate: vi.fn(),
    });
    const container = document.createElement("div");
    render(control.render("a"), container);
    container.querySelector<HTMLButtonElement>(".chat-send-btn--voice")?.click();
    await vi.waitFor(() => expect(pickerHarness.open).toHaveBeenCalledOnce());
    expect(dictationHarness.controllers[0]?.startDirect).not.toHaveBeenCalled();
    control.dispose();
  });

  it("drops a final transcript when cloud placement claims the draft in flight", () => {
    let canCommit = true;
    const insertTranscript = vi.fn(() => "spoken task");
    const onMessage = vi.fn();
    const control = new NewSessionDictationControl({
      textarea: { captureSelection: vi.fn(), insertTranscript } as never,
      getClient: () => client,
      isConnected: () => true,
      canCommit: () => canCommit,
      onMessage,
      onError: vi.fn(),
      onSubmit: vi.fn(),
      requestUpdate: vi.fn(),
    });

    control.render("agent-a");
    canCommit = false;
    dictationHarness.options?.onCommit("spoken task");

    expect(insertTranscript).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("starts canonical dictation from one microphone click after readiness", async () => {
    const onError = vi.fn();
    const captureSelection = vi.fn();
    const control = new NewSessionDictationControl({
      textarea: {
        captureSelection,
        insertTranscript: vi.fn(() => "spoken task"),
      } as never,
      getClient: () => client,
      isConnected: () => true,
      canCommit: () => true,
      onMessage: vi.fn(),
      onError,
      onSubmit: vi.fn(),
      requestUpdate: vi.fn(),
    });
    const container = document.createElement("div");
    render(control.render("agent-a"), container);
    const microphone = container.querySelector<HTMLButtonElement>(".chat-send-btn--voice");

    microphone?.click();

    expect(microphone).not.toBeNull();
    expect(microphone?.classList.contains("chat-send-btn--hold-enabled")).toBe(false);
    expect(
      (microphone?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)
        ?.content,
    ).toBe("Dictate");
    expect(captureSelection).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(dictationHarness.controllers[0]?.startDirect).toHaveBeenCalledOnce(),
    );
    expect(pickerHarness.sync).toHaveBeenCalledWith(client, true, false);
    expect(pickerHarness.prepare).toHaveBeenCalledOnce();
    expect(dictationHarness.controllers[0]?.handleClick).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    control.dispose();
  });

  it("keeps text from Stop and submits only after the Send check commits", async () => {
    const onMessage = vi.fn();
    const onSubmit = vi.fn();
    const control = new NewSessionDictationControl({
      textarea: {
        captureSelection: vi.fn(),
        insertTranscript: vi.fn(() => "draft spoken task"),
        previewTranscript: vi.fn(() => "draft spoken"),
      } as never,
      getClient: () => client,
      isConnected: () => true,
      canCommit: () => true,
      onMessage,
      onError: vi.fn(),
      onSubmit,
      requestUpdate: vi.fn(),
    });
    const container = document.createElement("div");
    control.render("agent-a");
    const controller = dictationHarness.controllers[0];
    if (!controller) {
      throw new Error("expected dictation controller");
    }

    controller.active = true;
    controller.transcript = "spoken";
    expect(control.previewDraft()).toBe("draft spoken");
    render(html`${control.renderStatus()}${control.render("agent-a")}`, container);
    expect(container.querySelector(".agent-chat__dictation-status")?.textContent).toContain(
      "Listening",
    );
    expect(container.querySelector(".agent-chat__dictation-phase--listening")).not.toBeNull();
    container.querySelector<HTMLButtonElement>(".chat-send-btn--dictating")?.click();
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith("draft spoken task"));
    expect(onSubmit).not.toHaveBeenCalled();

    controller.active = true;
    controller.finalizing = true;
    render(html`${control.renderStatus()}${control.render("agent-a")}`, container);
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

  it("cancels active dictation and drops its late transcript when the route owner changes", () => {
    const insertTranscript = vi.fn(() => "route B draft");
    const onMessage = vi.fn();
    const control = new NewSessionDictationControl({
      textarea: { captureSelection: vi.fn(), insertTranscript } as never,
      getClient: () => client,
      isConnected: () => true,
      canCommit: () => true,
      onMessage,
      onError: vi.fn(),
      onSubmit: vi.fn(),
      requestUpdate: vi.fn(),
    });

    control.render("agent-a");
    const routeAController = dictationHarness.controllers[0];
    routeAController?.handlePointerDown();
    const routeACommit = dictationHarness.options?.onCommit;

    control.render("agent-a");
    expect(dictationHarness.controllers).toHaveLength(1);
    expect(routeAController?.active).toBe(true);

    control.render("agent-b");
    routeACommit?.("late route A transcript");

    expect(routeAController?.active).toBe(false);
    expect(dictationHarness.controllers).toHaveLength(2);
    expect(insertTranscript).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });
});
