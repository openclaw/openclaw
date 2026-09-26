import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
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

describe("Browser panel paste", () => {
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
    const panel = document.createElement("openclaw-browser-panel") as unknown as HTMLElement & {
      available: boolean;
      embedded: boolean;
      presented: boolean;
      refreshOnPresentation: boolean;
      client: GatewayBrowserClient;
      browserPanelController: BrowserPanelController;
      renderRoot: ShadowRoot;
      requestUpdate: () => void;
      updateComplete: Promise<unknown>;
    };
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.refreshOnPresentation = false;
    panel.client = client;
    document.body.append(panel);
    await panel.updateComplete;
    const controller = panel.browserPanelController;
    controller.activeTargetId = "form-tab";
    controller.view = createView("form-tab");
    controller.operations.resetRoute({ profile: "work", target: "node", node: "browser-node" });
    panel.requestUpdate();
    await panel.updateComplete;
    return { panel, controller, request };
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
    const { panel, request } = await mount();
    const input = panel.renderRoot.querySelector<HTMLTextAreaElement>(".bp-input")!;
    expect(input).not.toBeNull();
    input.focus();
    expect(panel.renderRoot.activeElement).toBe(input);
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
    const inputEvent = new InputEvent("beforeinput", {
      inputType: "insertText",
      data: "x",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(inputEvent);
    expect(inputEvent.defaultPrevented).toBe(true);
  });

  it.each(["success", "failure", "route change", "new click"])(
    "waits for the remote click before pasting (%s)",
    async (outcome) => {
      const { panel, controller, request } = await mount();
      const click = createDeferred<unknown>();
      request.mockImplementationOnce(async () => click.promise);
      vi.spyOn(
        panel.renderRoot.querySelector(".bp-stage")!,
        "getBoundingClientRect",
      ).mockReturnValue(new DOMRect(0, 0, 100, 100));
      const input = panel.renderRoot.querySelector<HTMLTextAreaElement>(".bp-input")!;
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
      expect(insertions).toHaveLength(outcome === "success" ? 1 : 0);
    },
  );

  it("keeps typing behind queued field clicks", async () => {
    const { panel, request } = await mount();
    const firstClick = createDeferred<unknown>();
    request.mockImplementationOnce(async () => firstClick.promise);
    vi.spyOn(panel.renderRoot.querySelector(".bp-stage")!, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 100, 100),
    );
    const input = panel.renderRoot.querySelector<HTMLTextAreaElement>(".bp-input")!;
    input.click();
    input.click();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
    );
    expect(request).toHaveBeenCalledTimes(1);
    firstClick.resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(request.mock.calls.map(([, params]) => params)).toMatchObject([
      { body: { kind: "clickCoords" } },
      { body: { kind: "clickCoords" } },
      { body: { kind: "press", key: "a" } },
    ]);
  });

  it("requires a successful click after a settled focus failure before pasting", async () => {
    const { panel, request } = await mount();
    request.mockRejectedValueOnce(new Error("Click failed"));
    vi.spyOn(panel.renderRoot.querySelector(".bp-stage")!, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 100, 100),
    );
    const input = panel.renderRoot.querySelector<HTMLTextAreaElement>(".bp-input")!;
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

  it.each(["annotate", "inspect"] as const)(
    "does not paste into a captured %s view",
    async (mode) => {
      const { panel, controller, request } = await mount();
      controller.setMode(mode);
      await panel.updateComplete;
      panel.renderRoot.querySelector(".bp-viewport")!.dispatchEvent(paste("ignored"));
      expect(panel.renderRoot.querySelector(".bp-input")).toBeNull();
      expect(request).not.toHaveBeenCalled();
    },
  );

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
