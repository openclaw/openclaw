import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { stubResizeObserver } from "../../test-helpers/resize-observer.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import "./browser-panel.ts";
import {
  stubBrowserPanelTestStageBounds,
  createBrowserClient,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  stubScreenshotMedia,
  openBrowserActions,
  flushBrowserResponses as flush,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import { normalizeBrowserUrlDraft } from "./browser-url.ts";
import { createBrowserPageClient } from "./test-helpers/browser-page.ts";

type Panel = HTMLElementTagNameMap["openclaw-browser-panel"];
function persistedDock() {
  localStorage.setItem(
    "openclaw.browser.panel.v1",
    JSON.stringify({ open: true, dock: "right", height: 420, width: 560 }),
  );
}
function mountPanel(properties: Partial<Panel> = {}) {
  const panel = document.createElement("openclaw-browser-panel");
  Object.assign(panel, { available: true, embedded: true, presented: true }, properties);
  const mounted = mountSolid(() => panel);
  return { panel, mounted };
}
function toggle(panel: Panel, detail: { open: boolean; newTab?: boolean }) {
  panel.handleToggleRequest(new CustomEvent("openclaw:browser-toggle", { detail }));
}
async function annotate(panel: Panel) {
  (await openBrowserActions(panel))
    .querySelector<HTMLElement>('[role="menuitem"][aria-label="Annotate page"]')!
    .click();
  await panel.updateComplete;
}
function attachAnnotationOverlay(panel: HTMLElement) {
  const stage = panel.querySelector<HTMLElement>(".bp-stage")!;
  stubBrowserPanelTestStageBounds(stage);
  const overlay = stage.querySelector("canvas")!;
  const capturedPointers = new Set<number>();
  overlay.setPointerCapture = vi.fn((pointerId) => capturedPointers.add(pointerId));
  overlay.hasPointerCapture = vi.fn((pointerId) => capturedPointers.has(pointerId));
  overlay.releasePointerCapture = vi.fn((pointerId) => capturedPointers.delete(pointerId));

  const dispatchPointer = (
    type: "pointerdown" | "pointermove" | "pointerup",
    clientX: number,
    clientY: number,
  ) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
    Object.defineProperty(event, "pointerId", { configurable: true, value: 7 });
    overlay.dispatchEvent(event);
  };
  return { capturedPointers, dispatchPointer };
}

describe("Browser panel", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    stubResizeObserver();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("normalizes URL drafts", () => {
    expect(normalizeBrowserUrlDraft("example.com")).toBe("https://example.com/");
    expect(normalizeBrowserUrlDraft("  github.com/openclaw/openclaw ")).toBe(
      "https://github.com/openclaw/openclaw",
    );
    for (const draft of ["   ", "javascript:alert(1)", "file:///etc/passwd"]) {
      expect(normalizeBrowserUrlDraft(draft)).toBeNull();
    }
  });

  it("restores persisted open state when a mounted tag upgrades lazily", async () => {
    persistedDock();
    const tagName = `test-lazy-browser-panel-${crypto.randomUUID()}`;
    const element = document.createElement(tagName) as HTMLElement & { available: boolean };
    element.available = true;
    mountSolid(() => element);

    const BrowserPanel = customElements.get("openclaw-browser-panel");
    if (!BrowserPanel) {
      throw new Error("expected browser panel registration");
    }
    class LazyUpgradeBrowserPanel extends BrowserPanel {}
    customElements.define(tagName, LazyUpgradeBrowserPanel);
    const panel = element as unknown as HTMLElement & {
      browserPanelIsOpen(): boolean;
      updateComplete: Promise<unknown>;
    };
    await panel.updateComplete;
    expect(panel.browserPanelIsOpen()).toBe(true);
  });

  it("renders async page loads and retains the page and focus through successful and failed refreshes", async () => {
    stubScreenshotMedia();
    const response = createDeferred<unknown>();
    let refreshed = false;
    let tabsReply = response.promise;
    const url = "https://example.test/page";
    const client = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs") {
        return tabsReply;
      }
      if (envelope.path === "/screenshot") {
        return { path: refreshed ? "/fresh.png" : "/old.png", targetId: "raw-tab-a", url };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(url, refreshed ? "Updated page" : "First page");
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    }).client;
    const { panel } = mountPanel({ client });
    await waitForSolid(() => {
      expect(panel.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull();
      expect(panel.querySelector(".bp-viewport")?.getAttribute("aria-busy")).toBe("true");
    });

    response.resolve({
      running: true,
      tabs: [createBrowserPanelTestTab("tab-a", url, "First page")],
    });
    await waitForSolid(() => {
      expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
      expect(panel.querySelector(".bp-shot")?.getAttribute("alt")).toBe("First page");
    });
    const stage = panel.querySelector(".bp-stage");
    const image = panel.querySelector(".bp-shot");
    const input = panel.querySelector(".bp-input");
    const previousSource = image?.getAttribute("src");
    refreshed = true;
    toggle(panel, { open: true });
    await waitForSolid(() => {
      expect(image?.getAttribute("src")).not.toBe(previousSource);
      expect(image?.getAttribute("alt")).toBe("Updated page");
    });
    expect(panel.querySelector(".bp-stage")).toBe(stage);
    expect(panel.querySelector(".bp-shot")).toBe(image);
    expect(panel.querySelector(".bp-input")).toBe(input);

    const failure = createDeferred<unknown>();
    tabsReply = failure.promise;

    panel.querySelector<HTMLTextAreaElement>(".bp-input")?.focus();
    toggle(panel, { open: true });
    await panel.updateComplete;

    expect(panel.querySelector(".bp-shot")).toBe(image);
    expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    const reload = panel.querySelector('button[aria-label="Reload"]');
    expect(reload?.getAttribute("aria-busy")).toBe("true");
    expect(panel.querySelector(".bp-viewport")?.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(input);

    failure.reject(new Error("Refresh connection interrupted"));
    await waitForSolid(() => expect(reload?.getAttribute("aria-busy")).toBe("false"));

    expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    expect(panel.querySelector(".bp-shot")).toBe(image);
    expect(panel.querySelector('[role="alert"]')?.textContent).toContain(
      "Refresh connection interrupted",
    );
  });

  it("keeps an open dock's reservation while an embedded panel renders and unmounts", async () => {
    persistedDock();
    const dock = document.createElement("openclaw-browser-panel");
    const embedded = document.createElement("openclaw-browser-panel");
    // Chat side panels mount their Browser with the static `embedded` attribute.
    embedded.setAttribute("embedded", "");
    dock.available = embedded.available = true;
    mountSolid(() => [dock, embedded]);
    await Promise.all([dock.updateComplete, embedded.updateComplete]);
    const reservation = () =>
      document.documentElement.style.getPropertyValue("--oc-browser-reserve-right");
    expect(reservation()).toBe("560px");

    embedded.presented = true;
    await embedded.updateComplete;
    expect(reservation()).toBe("560px");
    embedded.remove();
    expect(reservation()).toBe("560px");

    toggle(dock, { open: false });
    expect(reservation()).toBe("0px");
  });

  it.each([false, true])(
    "restores a suppressed dock only once available: %s",
    async (available) => {
      persistedDock();
      const gateway = createBrowserClient(async () => ({}));
      const { panel } = mountPanel({
        embedded: false,
        presented: false,
        suppressed: true,
        available,
        client: gateway.client,
      });
      await panel.updateComplete;
      await Promise.resolve();
      expect(panel.browserPanelIsOpen()).toBe(false);
      expect(gateway.request).not.toHaveBeenCalled();
      panel.suppressed = false;
      if (!available) {
        await panel.updateComplete;
        expect(panel.browserPanelIsOpen()).toBe(false);
        panel.available = true;
      }
      await waitForSolid(() => expect(panel.browserPanelIsOpen()).toBe(true));
    },
  );

  it("undoes one annotation and clears the rest across retained panel updates", async () => {
    stubScreenshotMedia();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { panel } = mountPanel({ client: createBrowserPageClient("target-1").client });
    await waitForSolid(() => expect(panel.querySelector(".bp-shot")).not.toBeNull());
    await annotate(panel);
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>(".bp-annotatebar button")];
    const undo = buttons[0]!;
    const clear = buttons[1]!;
    const { dispatchPointer } = attachAnnotationOverlay(panel);
    expect(undo.disabled).toBe(true);
    expect(clear.disabled).toBe(true);
    for (const x of [10, 30]) {
      dispatchPointer("pointerdown", x, 20);
      dispatchPointer("pointermove", x + 10, 40);
      dispatchPointer("pointerup", x + 10, 40);
    }
    await panel.updateComplete;
    expect(undo.disabled).toBe(false);
    expect(clear.disabled).toBe(false);
    panel.tabsInHeader = true;
    await panel.updateComplete;
    expect([...panel.querySelectorAll(".bp-annotatebar button")]).toEqual(buttons);
    undo.click();
    await panel.updateComplete;
    expect(undo.disabled).toBe(false);
    expect(clear.disabled).toBe(false);
    clear.click();
    await panel.updateComplete;
    expect(undo.disabled).toBe(true);
    expect(clear.disabled).toBe(true);
  });

  it.each(["close", "suppress", "disconnect"] as const)(
    "ends an active annotation gesture on panel %s",
    async (transition) => {
      persistedDock();
      stubScreenshotMedia();
      const paint = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
      const { panel } = mountPanel({
        embedded: false,
        presented: false,
        client: createBrowserPageClient("target-1").client,
      });
      await waitForSolid(() => expect(panel.querySelector(".bp-shot")).not.toBeNull());
      await annotate(panel);
      const { capturedPointers, dispatchPointer } = attachAnnotationOverlay(panel);
      dispatchPointer("pointerdown", 10, 20);
      expect(capturedPointers.has(7)).toBe(true);

      if (transition === "close") {
        toggle(panel, { open: false });
      } else if (transition === "suppress") {
        panel.suppressed = true;
        await panel.updateComplete;
      } else {
        panel.remove();
        await waitForSolid(() => expect(capturedPointers.has(7)).toBe(false));
      }

      expect(capturedPointers.has(7)).toBe(false);
      paint.mockClear();
      dispatchPointer("pointermove", 30, 40);
      expect(paint).not.toHaveBeenCalled();
    },
  );

  it("settles a pending render when the panel is disposed", async () => {
    const { panel, mounted } = mountPanel();
    await panel.updateComplete;
    panel.tabsInHeader = true;
    const pending = panel.updateComplete;
    mounted.unmount();
    await expect(pending).resolves.toBe(false);
  });

  it("starts a fresh browser tab draft when an embedded panel receives a new-tab request", async () => {
    const { panel } = mountPanel();
    await panel.updateComplete;

    toggle(panel, { open: true, newTab: true });
    await panel.updateComplete;
    await Promise.resolve();

    expect(document.activeElement).toBe(panel.querySelector(".bp-url"));
  });
  describe("text entry", () => {
    function paste(text: string, types = ["text/plain"]) {
      const event = new Event("paste", { bubbles: true, composed: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          types,
          getData: (type: string) => (type === "text/plain" ? text : "<b>ignored</b>"),
        },
      });
      return event;
    }

    function sendInput(
      input: HTMLTextAreaElement,
      type: "beforeinput" | "input",
      inputType: string,
      data: string | null = null,
      options: InputEventInit = {},
    ) {
      input.dispatchEvent(
        new InputEvent(type, {
          inputType,
          data,
          bubbles: true,
          cancelable: type === "beforeinput",
          ...options,
        }),
      );
    }

    function key(input: HTMLTextAreaElement, options: KeyboardEventInit) {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...options }));
    }
    async function action(panel: HTMLElement, label: string) {
      return (await openBrowserActions(panel)).querySelector<HTMLElement>(
        `[role="menuitem"][aria-label="${label}"]`,
      )!;
    }

    beforeEach(() => vi.useFakeTimers());

    async function mountForm({ evaluateDisabled = false, clickable = false } = {}) {
      stubScreenshotMedia();
      const request = vi.fn(
        async (_method: string, _params?: BrowserRequestEnvelope): Promise<unknown> => ({
          ok: true,
        }),
      );
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
      const { panel } = mountPanel({
        client: gateway.client,
        preferredTab: {
          tab: { profile: "work", target: "node", node: "browser-node", targetId: "form-tab" },
          revision: "initial",
        },
      });
      await waitForSolid(() => expect(panel.querySelector(".bp-shot")).not.toBeNull());
      const input = panel.querySelector<HTMLTextAreaElement>(".bp-input")!;
      if (clickable) {
        vi.spyOn(panel.querySelector(".bp-stage")!, "getBoundingClientRect").mockReturnValue(
          new DOMRect(0, 0, 100, 100),
        );
      }
      return { panel, request, input, actions: () => request.mock.calls.map(([, p]) => p?.body) };
    }

    it.each([
      { outcome: "accepted", text: "  hello 🦞\n世界 <b>text</b>\t  " },
      { outcome: "failed", text: "synthetic password" },
    ])("consumes paste and redacts $outcome errors", async ({ outcome, text }) => {
      const { panel, request } = await mountForm({ evaluateDisabled: true });
      expect((await action(panel, "Inspect element")).getAttribute("aria-disabled")).toBe("true");
      if (outcome === "failed") {
        request.mockRejectedValueOnce(new Error(`Request failed: ${text}`));
      }
      const event = paste(text, ["text/plain", "text/html"]);
      const bubbled = vi.fn();
      panel.addEventListener("paste", bubbled);
      panel.querySelector(".bp-viewport")!.dispatchEvent(event);
      await flush();

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
    });

    it("forwards soft-keyboard text and editing without printable keydown events", async () => {
      const { input, actions } = await mountForm();
      for (const [inputType, data] of [
        ["insertText", "hello 🦞"],
        ["deleteContentBackward", null],
        ["insertLineBreak", null],
      ]) {
        key(input, { key: "Unidentified", keyCode: 229 });
        sendInput(input, "beforeinput", inputType!, data);
        await flush();
      }
      expect(actions()).toMatchObject([
        { kind: "insertText", targetId: "form-tab", text: "hello 🦞" },
        { kind: "press", targetId: "form-tab", key: "Backspace" },
        { kind: "press", targetId: "form-tab", key: "Enter" },
      ]);
      expect(input.value).toBe("");
    });

    it("does not append a local autocorrection to text already sent remotely", async () => {
      const { panel, request, input } = await mountForm();
      sendInput(input, "beforeinput", "insertText", "teh");
      await flush();
      input.value = "the";
      sendInput(input, "input", "insertReplacementText", "the");
      await flush();
      await panel.updateComplete;
      expect(request).toHaveBeenCalledTimes(1);
      expect(input.value).toBe("");
      expect(input.getAttribute("autocorrect")).toBe("off");
      expect(panel.querySelector('[role="status"]')?.textContent).toContain(
        "Edit the text directly",
      );
    });

    it.each(["committed", "route changed", "capture mode"])("commits IME: %s", async (outcome) => {
      const { panel, request, input, actions } = await mountForm();
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      key(input, { key: "a", isComposing: true });
      input.value = "に";
      sendInput(input, "input", "insertCompositionText", "に", { isComposing: true });
      expect(input.value).toBe("に");
      expect(request).not.toHaveBeenCalled();
      if (outcome === "route changed") {
        panel.sessionKey = "replacement-session";
        panel.handleToggleRequest(
          new CustomEvent("openclaw:browser-toggle", { detail: { open: false } }),
        );
      } else if (outcome === "capture mode") {
        (await action(panel, "Annotate page")).click();
      }
      input.value = "日本語";
      input.dispatchEvent(
        new CompositionEvent("compositionend", { data: "日本語", bubbles: true }),
      );
      sendInput(input, "beforeinput", "insertFromComposition", "日本語");
      sendInput(input, "input", "insertFromComposition", "日本語");
      await flush();
      expect(input.value).toBe("");
      if (outcome === "committed") {
        expect(request.mock.calls[0]?.[0]).toBe("browser.request");
        expect(actions()).toEqual([{ kind: "insertText", text: "日本語", targetId: "form-tab" }]);
      } else {
        expect(request).not.toHaveBeenCalled();
      }
    });

    it("uses input for uncancelable commits and batches queued text without crossing keys or clicks", async () => {
      const { request, input, actions } = await mountForm({ clickable: true });
      const insert = createDeferred<unknown>();
      request.mockImplementationOnce(async () => insert.promise);
      sendInput(input, "beforeinput", "insertText", "hello", { cancelable: false });
      expect(request).not.toHaveBeenCalled();
      input.value = "hello";
      sendInput(input, "input", "insertText", "hello");
      const type = (text: string) => sendInput(input, "beforeinput", "insertText", text);
      type("a");
      type("b");
      sendInput(input, "beforeinput", "deleteContentBackward");
      expect(input.value).toBe("");
      type("c");
      input.click();
      type("d");
      expect(request).toHaveBeenCalledTimes(1);
      insert.resolve({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(actions()).toMatchObject([
        { kind: "insertText", text: "hello" },
        { kind: "insertText", text: "ab" },
        { kind: "press", key: "Backspace" },
        { kind: "insertText", text: "c" },
        { kind: "clickCoords" },
        { kind: "insertText", text: "d" },
      ]);
    });

    it.each(["failure", "route change", "new click"])(
      "paste waits for click: %s",
      async (outcome) => {
        const { panel, request, input, actions } = await mountForm({ clickable: true });
        const click = createDeferred<unknown>();
        request.mockImplementationOnce(async () => click.promise);
        input.click();
        input.dispatchEvent(paste("for the clicked field"));
        expect(request).toHaveBeenCalledTimes(1);
        expect(actions()[0]).toMatchObject({ kind: "clickCoords" });
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
        const insertions = actions().filter((body) => body?.kind === "insertText");
        expect(insertions).toHaveLength(outcome === "new click" ? 1 : 0);
        if (outcome === "new click") {
          expect(actions()).toMatchObject([
            { kind: "clickCoords" },
            { kind: "insertText", text: "for the clicked field" },
            { kind: "clickCoords" },
          ]);
        }
      },
    );

    it.each([false, true])(
      "queues clicks before typing (pending text: %s)",
      async (pendingText) => {
        const { request, input, actions } = await mountForm({ clickable: true });
        const precedingText = createDeferred<unknown>();
        const firstClick = createDeferred<unknown>();
        if (pendingText) {
          request.mockImplementationOnce(async () => precedingText.promise);
        }
        request.mockImplementationOnce(async () => firstClick.promise);
        if (pendingText) {
          input.dispatchEvent(paste("previous field"));
        }
        input.click();
        input.click();
        key(input, { key: "a", cancelable: true });
        expect(request).toHaveBeenCalledTimes(1);
        precedingText.resolve({ ok: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledTimes(pendingText ? 2 : 1);
        firstClick.resolve({ ok: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(actions()).toMatchObject([
          ...(pendingText ? [{ kind: "insertText", text: "previous field" }] : []),
          { kind: "clickCoords" },
          { kind: "clickCoords" },
          { kind: "press", key: "a" },
        ]);
      },
    );

    it("requires a successful click after a settled focus failure before pasting", async () => {
      const { request, input, actions } = await mountForm({ clickable: true });
      request.mockRejectedValueOnce(new Error("Click failed"));
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
      expect(actions()[2]).toMatchObject({ kind: "insertText", text: "correct field" });
    });

    it.each(["empty", "files", "disconnected", "changing tab", "captured view"])(
      "does not send %s clipboard input",
      async (reason) => {
        const { panel, request } = await mountForm();
        if (reason === "disconnected") {
          panel.remove();
        }
        if (reason === "changing tab") {
          panel.selectHostedTab("previous-tab");
        }
        if (reason === "captured view") {
          (await action(panel, "Annotate page")).click();
          await panel.updateComplete;
          expect(panel.querySelector(".bp-input")).toBeNull();
        }
        const text = reason === "empty" ? "" : "ignored";
        const types = reason === "files" ? ["Files"] : ["text/plain"];
        panel.querySelector(".bp-viewport")!.dispatchEvent(paste(text, types));
        expect(request).not.toHaveBeenCalled();
      },
    );
  });
});
