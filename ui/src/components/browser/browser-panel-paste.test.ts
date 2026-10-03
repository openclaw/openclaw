import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createBrowserClient,
  createView,
  flushBrowserResponses,
} from "./browser-panel-controller-test-support.ts";
import type { BrowserPanelController } from "./browser-panel-controller.ts";
import "./browser-panel.ts";

function paste(text: string, types = ["text/plain"]) {
  const event = new Event("paste", { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { types, getData: (type: string) => (type === "text/plain" ? text : "<b>ignored</b>") },
  });
  return event;
}

function textInput(
  type: "beforeinput" | "input",
  inputType: string,
  data: string | null = null,
  options: InputEventInit = {},
) {
  return new InputEvent(type, {
    inputType,
    data,
    bubbles: true,
    cancelable: type === "beforeinput",
    ...options,
  });
}

function touch(type: string, clientX: number, clientY: number, options: PointerEventInit = {}) {
  return new PointerEvent(type, {
    pointerId: 1,
    pointerType: "touch",
    clientX,
    clientY,
    bubbles: true,
    ...options,
  });
}

function setStageSize(panel: HTMLElementTagNameMap["openclaw-browser-panel"], size = 100) {
  vi.spyOn(panel.renderRoot.querySelector(".bp-stage")!, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, size, size),
  );
}

describe("Browser panel text and touch input", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("ResizeObserver", undefined);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount() {
    const { client, request } = createBrowserClient(async () => ({ ok: true }));
    const panel = document.createElement("openclaw-browser-panel");
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.refreshOnPresentation = false;
    panel.client = client;
    document.body.append(panel);
    await panel.updateComplete;
    const controller = (panel as unknown as { browserPanelController: BrowserPanelController })
      .browserPanelController;
    controller.activeTargetId = "form-tab";
    controller.view = createView("form-tab");
    controller.operations.resetRoute({ profile: "work", target: "node", node: "browser-node" });
    panel.requestUpdate();
    await panel.updateComplete;
    const input = panel.renderRoot.querySelector<HTMLTextAreaElement>(".bp-input")!;
    return { panel, controller, request, input };
  }

  it("forwards plain text once to the selected browser and consumes the local paste", async () => {
    const { panel, controller, request } = await mount();
    controller.evaluateUnavailable = true;
    const text = "  hello 🦞\n世界 <b>text</b>\t  ";
    const event = paste(text, ["text/plain", "text/html"]);
    const bubbled = vi.fn();
    panel.addEventListener("paste", bubbled);
    panel.renderRoot.querySelector(".bp-viewport")!.dispatchEvent(event);
    await flushBrowserResponses();

    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledExactlyOnceWith("browser.request", {
      method: "POST",
      path: "/act",
      target: "node",
      node: "browser-node",
      query: { profile: "work" },
      body: { kind: "insertText", targetId: "form-tab", text },
    });
  });

  it("offers an empty editable input surface while typing stays remote", async () => {
    const { panel, request, input } = await mount();
    expect(input).not.toBeNull();
    input.focus();
    expect(panel.shadowRoot?.activeElement).toBe(input);
    const key = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    input.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        body: expect.objectContaining({ kind: "press", key: "a" }),
      }),
    );
    const event = paste("synthetic password");
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe("");
    const inputEvent = textInput("beforeinput", "insertText", "x");
    input.dispatchEvent(inputEvent);
    expect(inputEvent.defaultPrevented).toBe(true);
  });

  it("forwards soft-keyboard text and editing without printable keydown events", async () => {
    const { request, input } = await mount();
    for (const [inputType, data] of [
      ["insertText", "hello 🦞"],
      ["deleteContentBackward", null],
      ["insertLineBreak", null],
    ]) {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Unidentified", keyCode: 229, bubbles: true }),
      );
      input.dispatchEvent(textInput("beforeinput", inputType!, data));
      await flushBrowserResponses();
    }
    expect(request.mock.calls.map(([, params]) => params)).toMatchObject([
      { body: { kind: "insertText", targetId: "form-tab", text: "hello 🦞" } },
      { body: { kind: "press", targetId: "form-tab", key: "Backspace" } },
      { body: { kind: "press", targetId: "form-tab", key: "Enter" } },
    ]);
    expect(input.value).toBe("");
  });

  it("does not append a local autocorrection to text already sent remotely", async () => {
    const { panel, request, input } = await mount();
    input.dispatchEvent(textInput("beforeinput", "insertText", "teh"));
    await flushBrowserResponses();
    input.value = "the";
    input.dispatchEvent(textInput("input", "insertReplacementText", "the"));
    await flushBrowserResponses();
    await panel.updateComplete;
    expect(request).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("");
    expect(input.getAttribute("autocorrect")).toBe("off");
    expect(panel.renderRoot.querySelector('[role="status"]')?.textContent).toContain(
      "Edit the text directly",
    );
  });

  it("scrolls a touch swipe in remote coordinates without clicking its end point", async () => {
    const { panel, request, input } = await mount();
    setStageSize(panel, 50);
    for (const [type, clientY] of [
      ["pointerdown", 40],
      ["pointermove", 10],
      ["pointerup", 10],
    ] as const) {
      input.dispatchEvent(touch(type, 20, clientY, { cancelable: true }));
    }
    input.click();
    await vi.advanceTimersByTimeAsync(150);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "browser.request",
      expect.objectContaining({
        target: "node",
        node: "browser-node",
        query: { profile: "work" },
        body: {
          kind: "evaluate",
          targetId: "form-tab",
          fn: expect.stringContaining("window.scrollBy(0, 60)"),
        },
      }),
    );
    input.dispatchEvent(touch("pointerdown", 10, 20, { pointerId: 2 }));
    input.dispatchEvent(touch("pointerup", 10, 20, { pointerId: 2 }));
    input.dispatchEvent(new MouseEvent("click", { clientX: 10, clientY: 20, bubbles: true }));
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      body: { kind: "clickCoords", x: 20, y: 40 },
    });
  });

  it.each(["committed", "route changed", "capture mode"])(
    "sends composition once only to its original field (%s)",
    async (outcome) => {
      const { controller, request, input } = await mount();
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", isComposing: true, bubbles: true }),
      );
      input.value = "に";
      input.dispatchEvent(textInput("input", "insertCompositionText", "に", { isComposing: true }));
      expect(input.value).toBe("に");
      expect(request).not.toHaveBeenCalled();
      if (outcome === "route changed") {
        controller.operations.resetRoute({ profile: "other", target: "host" });
      } else if (outcome === "capture mode") {
        controller.setMode("annotate");
      }
      input.value = "日本語";
      input.dispatchEvent(
        new CompositionEvent("compositionend", { data: "日本語", bubbles: true }),
      );
      input.dispatchEvent(textInput("beforeinput", "insertFromComposition", "日本語"));
      input.dispatchEvent(textInput("input", "insertFromComposition", "日本語"));
      await flushBrowserResponses();
      expect(input.value).toBe("");
      if (outcome === "committed") {
        expect(request).toHaveBeenCalledExactlyOnceWith(
          "browser.request",
          expect.objectContaining({
            body: { kind: "insertText", text: "日本語", targetId: "form-tab" },
          }),
        );
      } else {
        expect(request).not.toHaveBeenCalled();
      }
    },
  );

  it("uses input for uncancelable commits and preserves text/edit order across async requests", async () => {
    const { request, input } = await mount();
    const insert = createDeferred<unknown>();
    request.mockImplementationOnce(async () => insert.promise);
    input.dispatchEvent(textInput("beforeinput", "insertText", "hello", { cancelable: false }));
    expect(request).not.toHaveBeenCalled();
    input.value = "hello";
    input.dispatchEvent(textInput("input", "insertText", "hello"));
    input.dispatchEvent(textInput("beforeinput", "deleteContentBackward"));
    expect(input.value).toBe("");
    expect(request).toHaveBeenCalledTimes(1);
    insert.resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(request.mock.calls.map(([, params]) => params)).toMatchObject([
      { body: { kind: "insertText", text: "hello" } },
      { body: { kind: "press", key: "Backspace" } },
    ]);
  });

  it("discards a swipe queued before the browser route changes", async () => {
    const { panel, controller, request, input } = await mount();
    setStageSize(panel);
    input.dispatchEvent(touch("pointerdown", 20, 70));
    input.dispatchEvent(touch("pointermove", 20, 20));
    controller.operations.resetRoute({ profile: "other", target: "host" });
    await vi.advanceTimersByTimeAsync(150);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["failure", "route change", "new click"])(
    "waits for the remote click before pasting (%s)",
    async (outcome) => {
      const { panel, controller, request, input } = await mount();
      const click = createDeferred<unknown>();
      request.mockImplementationOnce(async () => click.promise);
      setStageSize(panel);
      input.click();
      input.dispatchEvent(paste("for the clicked field"));
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]?.[1]).toMatchObject({ body: { kind: "clickCoords" } });
      if (outcome === "route change") {
        controller.operations.resetRoute();
      }
      if (outcome === "new click") {
        input.click();
      }
      if (outcome === "failure") {
        click.reject(new Error("Click failed"));
      } else {
        click.resolve({ ok: true });
      }
      await vi.advanceTimersByTimeAsync(0);
      const insertions = request.mock.calls.filter(
        ([, params]) => (params as { body?: { kind?: string } }).body?.kind === "insertText",
      );
      expect(insertions).toHaveLength(outcome === "new click" ? 1 : 0);
      if (outcome === "new click") {
        expect(request.mock.calls.map(([, params]) => params)).toMatchObject([
          { body: { kind: "clickCoords" } },
          { body: { kind: "insertText", text: "for the clicked field" } },
          { body: { kind: "clickCoords" } },
        ]);
      }
    },
  );

  it.each([false, true])(
    "keeps typing behind queued field clicks (pending text: %s)",
    async (pendingText) => {
      const { panel, request, input } = await mount();
      const precedingText = createDeferred<unknown>();
      const firstClick = createDeferred<unknown>();
      if (pendingText) {
        request.mockImplementationOnce(async () => precedingText.promise);
      }
      request.mockImplementationOnce(async () => firstClick.promise);
      setStageSize(panel);
      if (pendingText) {
        input.dispatchEvent(paste("previous field"));
      }
      input.click();
      input.click();
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
      );
      expect(request).toHaveBeenCalledTimes(1);
      precedingText.resolve({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(pendingText ? 2 : 1);
      firstClick.resolve({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(request.mock.calls.map(([, params]) => params)).toMatchObject([
        ...(pendingText ? [{ body: { kind: "insertText", text: "previous field" } }] : []),
        { body: { kind: "clickCoords" } },
        { body: { kind: "clickCoords" } },
        { body: { kind: "press", key: "a" } },
      ]);
    },
  );

  it("requires a successful click after a settled focus failure before pasting", async () => {
    const { panel, request, input } = await mount();
    request.mockRejectedValueOnce(new Error("Click failed"));
    setStageSize(panel);
    input.click();
    await vi.advanceTimersByTimeAsync(0);
    input.dispatchEvent(paste("do not send to the previous field"));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);

    input.click();
    await vi.advanceTimersByTimeAsync(0);
    input.dispatchEvent(paste("correct field"));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      body: { kind: "insertText", text: "correct field" },
    });
  });

  it("does not paste into a captured view", async () => {
    const { panel, controller, request } = await mount();
    controller.setMode("annotate");
    await panel.updateComplete;
    panel.renderRoot.querySelector(".bp-viewport")!.dispatchEvent(paste("ignored"));
    expect(panel.renderRoot.querySelector(".bp-input")).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["empty", "files", "disconnected", "stale view"])(
    "does not send %s clipboard input",
    async (reason) => {
      const { panel, controller, request } = await mount();
      if (reason === "disconnected") {
        panel.remove();
      }
      if (reason === "stale view") {
        controller.view = createView("previous-tab");
      }
      panel.renderRoot
        .querySelector(".bp-viewport")!
        .dispatchEvent(
          paste(
            reason === "empty" ? "" : "ignored",
            reason === "files" ? ["Files"] : ["text/plain"],
          ),
        );
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("keeps clipboard content out of a failed request's displayed error", async () => {
    const { panel, request } = await mount();
    request.mockRejectedValueOnce(new Error("Request failed: synthetic password"));
    panel.renderRoot.querySelector(".bp-viewport")!.dispatchEvent(paste("synthetic password"));
    await flushBrowserResponses();
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not paste",
    );
    expect(panel.renderRoot.textContent).not.toContain("synthetic password");
  });
});
