import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  flushBrowserResponses,
  stubScreenshotMedia,
} from "./browser-panel-controller-test-support.ts";
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

function setStageSize(panel: HTMLElementTagNameMap["openclaw-browser-panel"], size = 100) {
  vi.spyOn(panel.querySelector(".bp-stage")!, "getBoundingClientRect").mockReturnValue(
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

  async function mount(evaluateDisabled = false) {
    stubScreenshotMedia();
    // Only input RPCs are deferred by these tests; page setup and refresh still
    // cross the actual Gateway request adapter and native panel lifecycle.
    const request = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({
      ok: true,
    }));
    const url = "https://example.test/page";
    const gateway = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs") {
        return {
          running: true,
          tabs: [
            createBrowserPanelTestTab("form-tab", url, "Form"),
            createBrowserPanelTestTab("previous-tab", url, "Other"),
          ],
        };
      }
      if (envelope.path === "/screenshot") {
        return { path: "/fresh.png", targetId: envelope.body?.targetId, url };
      }
      if (envelope.path === "/act" && envelope.body?.kind === "evaluate") {
        if (evaluateDisabled) {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Evaluation disabled",
            details: { code: "ACT_EVALUATE_DISABLED" },
          });
        }
        return createBrowserPanelTestMetrics(url, "Form");
      }
      if (envelope.path === "/tabs/focus") {
        return { ok: true };
      }
      return request("browser.request", envelope);
    });
    const panel = document.createElement("openclaw-browser-panel");
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.client = gateway.client;
    panel.preferredTab = {
      tab: { profile: "work", target: "node", node: "browser-node", targetId: "form-tab" },
      revision: "initial",
    };
    mountSolid(() => panel);
    await waitForSolid(() => expect(panel.querySelector(".bp-shot")).not.toBeNull());
    const input = panel.querySelector<HTMLTextAreaElement>(".bp-input")!;
    return { panel, request, input };
  }

  it.each([
    { outcome: "accepted", text: "  hello 🦞\n世界 <b>text</b>\t  " },
    { outcome: "failed", text: "synthetic password" },
  ])(
    "consumes a remote paste and keeps its content out of $outcome errors",
    async ({ outcome, text }) => {
      const { panel, request } = await mount(true);
      expect(
        panel.querySelector<HTMLButtonElement>('[aria-label="Inspect element"]')?.disabled,
      ).toBe(true);
      if (outcome === "failed") {
        request.mockRejectedValueOnce(new Error(`Request failed: ${text}`));
      }
      const event = paste(text, ["text/plain", "text/html"]);
      const bubbled = vi.fn();
      panel.addEventListener("paste", bubbled);
      panel.querySelector(".bp-viewport")!.dispatchEvent(event);
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
      if (outcome === "failed") {
        await panel.updateComplete;
        expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Could not paste");
        expect(panel.textContent).not.toContain(text);
      }
    },
  );

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
    expect(panel.querySelector('[role="status"]')?.textContent).toContain("Edit the text directly");
  });

  it.each(["committed", "route changed", "capture mode"])(
    "sends composition once only to its original field (%s)",
    async (outcome) => {
      const { panel, request, input } = await mount();
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", isComposing: true, bubbles: true }),
      );
      input.value = "に";
      input.dispatchEvent(textInput("input", "insertCompositionText", "に", { isComposing: true }));
      expect(input.value).toBe("に");
      expect(request).not.toHaveBeenCalled();
      if (outcome === "route changed") {
        panel.sessionKey = "replacement-session";
        panel.handleToggleRequest(
          new CustomEvent("openclaw:browser-toggle", { detail: { open: false } }),
        );
      } else if (outcome === "capture mode") {
        panel.querySelector<HTMLButtonElement>('[aria-label="Annotate page"]')!.click();
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

  it.each(["failure", "route change", "new click"])(
    "waits for the remote click before pasting (%s)",
    async (outcome) => {
      const { panel, request, input } = await mount();
      const click = createDeferred<unknown>();
      request.mockImplementationOnce(async () => click.promise);
      setStageSize(panel);
      input.click();
      input.dispatchEvent(paste("for the clicked field"));
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]?.[1]).toMatchObject({ body: { kind: "clickCoords" } });
      if (outcome === "route change") {
        panel.sessionKey = "replacement-session";
        await panel.updateComplete;
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

  it.each(["empty", "files", "disconnected", "changing tab", "captured view"])(
    "does not send %s clipboard input",
    async (reason) => {
      const { panel, request } = await mount();
      if (reason === "disconnected") {
        panel.remove();
      }
      if (reason === "changing tab") {
        panel.selectHostedTab("previous-tab");
      }
      if (reason === "captured view") {
        panel.querySelector<HTMLButtonElement>('[aria-label="Annotate page"]')!.click();
        await panel.updateComplete;
        expect(panel.querySelector(".bp-input")).toBeNull();
      }
      panel
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
});
