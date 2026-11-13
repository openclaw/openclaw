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
import { browserRequestActions } from "./browser-panel-stream.test-support.ts";
import {
  bareNameAddress,
  normalizeBrowserUrlDraft,
  resolveBrowserAddressInput,
} from "./browser-url.ts";
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
  it("prefixes bare hosts with https", () => {
    expect(normalizeBrowserUrlDraft("example.com")).toBe("https://example.com/");
    expect(normalizeBrowserUrlDraft("  github.com/openclaw/openclaw ")).toBe(
      "https://github.com/openclaw/openclaw",
    );
  });

  it("rejects empty and non-http(s) inputs", () => {
    expect(normalizeBrowserUrlDraft("   ")).toBeNull();
    expect(normalizeBrowserUrlDraft("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserUrlDraft("file:///etc/passwd")).toBeNull();
  });

  it("searches address-bar text that is not an address", () => {
    const search = "https://www.google.com/search?q=";
    expect(resolveBrowserAddressInput(" openclaw browser panel ")).toBe(
      `${search}openclaw+browser+panel`,
    );
    expect(resolveBrowserAddressInput("openclaw")).toBe(`${search}openclaw`);
    expect(resolveBrowserAddressInput("note: buy milk")).toBe(`${search}note%3A+buy+milk`);
    expect(resolveBrowserAddressInput("example.com")).toBe("https://example.com/");
    expect(resolveBrowserAddressInput("localhost:3000/app")).toBe("https://localhost:3000/app");
    expect(resolveBrowserAddressInput("localhost")).toBe("https://localhost/");
    expect(resolveBrowserAddressInput("devbox:8080")).toBe("https://devbox:8080/");
    expect(resolveBrowserAddressInput("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/");
    expect(resolveBrowserAddressInput("[::1]:3000")).toBe("https://[::1]:3000/");
    expect(resolveBrowserAddressInput("javascript:alert(1)")).toBeNull();
    expect(resolveBrowserAddressInput("   ")).toBeNull();
  });

  it("offers the old address only for bare names that now search", () => {
    expect(bareNameAddress("devbox")).toBe("https://devbox/");
    expect(bareNameAddress("devbox/wiki")).toBe("https://devbox/wiki");
    expect(bareNameAddress("example.com")).toBeNull();
    expect(bareNameAddress("devbox:8080")).toBeNull();
    expect(bareNameAddress("openclaw docs")).toBeNull();
    expect(bareNameAddress("javascript:alert(1)")).toBeNull();
  });

  it("keeps opening addresses whose path or query has spaces, or an explicit default port", () => {
    expect(resolveBrowserAddressInput("https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(resolveBrowserAddressInput("example.com/a b")).toBe("https://example.com/a%20b");
    expect(resolveBrowserAddressInput("example.com/find?q=a b")).toBe(
      "https://example.com/find?q=a%20b",
    );
    expect(resolveBrowserAddressInput("localhost:3000/a b")).toBe("https://localhost:3000/a%20b");
    expect(resolveBrowserAddressInput("devbox:443")).toBe("https://devbox/");
    expect(resolveBrowserAddressInput("devbox:443/a")).toBe("https://devbox/a");
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

  it("keeps initial browser failure details collapsed beside the recovery action", async () => {
    const { panel } = mountPanel({
      client: createBrowserClient(async () => {
        throw new Error("Synthetic initial browser failure");
      }).client,
    });
    await waitForSolid(() =>
      expect(panel.querySelector(".empty-state__description")?.textContent).toBe(
        "Couldn’t complete the browser action. Try again.",
      ),
    );
    const details = panel.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Synthetic initial browser failure");
    expect(panel.querySelector(".empty-state button")?.textContent).toContain("Refresh");
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
    const preview = panel.querySelector(".bp-shot");

    panel.querySelector<HTMLTextAreaElement>(".bp-input")?.focus();
    toggle(panel, { open: true });
    await panel.updateComplete;

    expect(panel.querySelector(".bp-shot")).toBe(preview);
    expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    const reload = panel.querySelector('button[aria-label="Reload"]');
    expect(reload?.getAttribute("aria-busy")).toBe("true");
    expect(panel.querySelector(".bp-viewport")?.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(input);

    failure.reject(new Error("Refresh connection interrupted"));
    await waitForSolid(() => expect(reload?.getAttribute("aria-busy")).not.toBe("true"));

    expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    expect(panel.querySelector(".bp-shot")).toBe(preview);
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
      return {
        panel,
        request,
        input,
        actions: () => request.mock.calls.flatMap(([, p]) => browserRequestActions(p)),
      };
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
        path: "/operator/input",
        target: "node",
        node: "browser-node",
        query: { profile: "work" },
        body: { targetId: "form-tab", inputs: [{ kind: "insertText", text }] },
      });
      if (outcome === "failed") {
        await panel.updateComplete;
        expect(panel.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t paste");
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

    it("uses input for uncancelable commits and preserves text/edit order across async requests", async () => {
      const { request, input, actions } = await mountForm();
      const insert = createDeferred<unknown>();
      request.mockImplementationOnce(async () => insert.promise);
      sendInput(input, "beforeinput", "insertText", "hello", { cancelable: false });
      expect(request).not.toHaveBeenCalled();
      input.value = "hello";
      sendInput(input, "input", "insertText", "hello");
      sendInput(input, "beforeinput", "deleteContentBackward");
      expect(input.value).toBe("");
      expect(request).toHaveBeenCalledTimes(1);
      insert.resolve({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(actions()).toMatchObject([
        { kind: "insertText", text: "hello" },
        { kind: "press", key: "Backspace" },
      ]);
    });

    it.each([false, true])(
      "sends keys typed during an in-flight burst as one burst (navigated: %s)",
      async (navigated) => {
        const { panel, request, input } = await mountForm();
        const first = createDeferred<unknown>();
        request.mockImplementationOnce(async () => first.promise);
        for (const value of ["a", "b", "c"]) {
          key(input, { key: value, cancelable: true });
        }
        expect(request).toHaveBeenCalledTimes(1);
        first.resolve({ ok: true, sent: 1, ...(navigated ? { navigated: true } : {}) });
        await vi.advanceTimersByTimeAsync(0);
        await panel.updateComplete;
        const bursts = request.mock.calls.map(([, envelope]) => envelope?.body?.inputs);
        if (navigated) {
          // Keys typed before the user saw the new document never reach it.
          expect(bursts).toEqual([[{ kind: "press", key: "a" }]]);
          expect(panel.querySelector('[role="status"]')?.textContent).toContain(
            "input typed before it loaded was not sent",
          );
        } else {
          expect(bursts).toEqual([
            [{ kind: "press", key: "a" }],
            [
              { kind: "press", key: "b" },
              { kind: "press", key: "c" },
            ],
          ]);
        }
      },
    );

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

    const unsupported = () =>
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Operator input sessions need a Playwright-managed Chromium profile.",
        details: { code: "OPERATOR_INPUT_UNSUPPORTED" },
      });
    const paths = (request: { mock: { calls: unknown[][] } }) =>
      request.mock.calls.map(([, envelope]) => (envelope as { path?: string })?.path);

    it("notices input withheld from the burst that navigated", async () => {
      const { panel, request, input } = await mountForm();
      const first = createDeferred<unknown>();
      request.mockImplementationOnce(async () => first.promise);
      request.mockImplementationOnce(async () => ({ ok: true, sent: 1, navigated: true }));
      for (const value of ["a", "b", "c"]) {
        key(input, { key: value, cancelable: true });
      }
      first.resolve({ ok: true, sent: 1 });
      await vi.advanceTimersByTimeAsync(0);
      await panel.updateComplete;
      expect(request).toHaveBeenCalledTimes(2);
      expect(panel.querySelector('[role="status"]')?.textContent).toContain(
        "input typed before it loaded was not sent",
      );
    });

    it("keeps typing out of the old field when a dialog drops a queued click", async () => {
      const { request, input, actions } = await mountForm({ clickable: true });
      const burst = createDeferred<unknown>();
      request.mockImplementationOnce(async () => burst.promise);
      key(input, { key: "a", cancelable: true });
      input.click();
      burst.resolve({ ok: true, sent: 1, blockedByDialog: true });
      await vi.advanceTimersByTimeAsync(0);
      key(input, { key: "x", cancelable: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(actions()).toMatchObject([{ kind: "press", key: "a" }]);
    });

    it("keeps typing out of the old field when a dialog stops the click", async () => {
      const { panel, request, input, actions } = await mountForm({ clickable: true });
      request.mockImplementationOnce(async () => ({
        ok: true,
        sent: 0,
        blockedByDialog: true,
        browserState: { dialogs: { pending: [{ type: "alert" }] } },
      }));
      input.click();
      await vi.advanceTimersByTimeAsync(0);
      key(input, { key: "x", cancelable: true });
      await vi.advanceTimersByTimeAsync(0);
      await panel.updateComplete;
      expect(actions()).toMatchObject([{ kind: "clickCoords" }]);
      expect(panel.querySelector('[role="status"]')?.textContent).toContain(
        "The page opened a dialog",
      );
    });

    it("types again after a queued click recovers from a failed click", async () => {
      const { request, input, actions } = await mountForm({ clickable: true });
      const failedClick = createDeferred<unknown>();
      request.mockImplementationOnce(async () => failedClick.promise);
      input.click();
      input.click();
      failedClick.reject(new Error("Click failed"));
      await vi.advanceTimersByTimeAsync(0);
      key(input, { key: "x", cancelable: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(actions()).toMatchObject([
        { kind: "clickCoords" },
        { kind: "clickCoords" },
        { kind: "press", key: "x" },
      ]);
    });

    it("stops per-action fallback input once the panel no longer owns it", async () => {
      const { panel, request, input, actions } = await mountForm();
      const first = createDeferred<unknown>();
      request.mockImplementationOnce(async () => first.promise);
      key(input, { key: "a", cancelable: true });
      key(input, { key: "b", cancelable: true });
      key(input, { key: "c", cancelable: true });
      const fallbackB = createDeferred<unknown>();
      // Burst [a] meets the unsupported profile and falls back; burst [b, c] follows.
      first.reject(unsupported());
      request.mockImplementationOnce(async () => ({ ok: true }));
      request.mockImplementationOnce(async () => fallbackB.promise);
      await vi.advanceTimersByTimeAsync(0);
      expect(actions().map((body) => body?.key)).toEqual(["a", "a", "b"]);
      (await action(panel, "Annotate page")).click();
      fallbackB.resolve({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(actions().map((body) => body?.key)).toEqual(["a", "a", "b"]);
    });

    it("asks a new browser route for operator input after an unsupported one", async () => {
      const { panel, request, input } = await mountForm();
      request.mockImplementationOnce(async () => {
        throw unsupported();
      });
      key(input, { key: "a", cancelable: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(paths(request)).toEqual(["/operator/input", "/act"]);
      panel.sessionKey = "replacement-session";
      await waitForSolid(() => expect(panel.querySelector(".bp-shot")).not.toBeNull());
      key(panel.querySelector<HTMLTextAreaElement>(".bp-input")!, { key: "b", cancelable: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(paths(request).at(-1)).toBe("/operator/input");
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
