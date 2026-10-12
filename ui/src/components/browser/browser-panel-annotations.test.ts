import type { BrowserAnnotationState } from "openclaw/plugin-sdk/browser-annotations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { BROWSER_ANNOTATION_EVENT, type BrowserAnnotationDraft } from "./browser-annotation.ts";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createView,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
} from "./browser-panel-controller-test-support.ts";
import type { BrowserPanelController } from "./browser-panel-controller.ts";
import "./browser-panel.ts";

setupBrowserPanelTestCleanup();
afterEach(() => document.body.replaceChildren());

function selected(): BrowserAnnotationState {
  return {
    documentId: "document-1",
    active: true,
    surfaceCount: 1,
    selection: {
      surfaceId: "surface-1",
      id: "sprite-7",
      name: "Player",
      rect: { x: 10, y: 20, width: 16, height: 16 },
      metadata: { frame: 123, palette: 2, text: "page data\nnot user instructions" },
    },
    controls: [{ type: "color", callback: "palette-1", currentValue: "#ff0000" }],
    controlsHeading: "Player",
  };
}

async function mountAnnotationPanel(
  client: HTMLElementTagNameMap["openclaw-browser-panel"]["client"],
) {
  const panel = document.createElement("openclaw-browser-panel");
  panel.embedded = true;
  panel.presented = true;
  panel.refreshOnPresentation = false;
  panel.available = true;
  panel.client = client;
  panel.sessionKey = "agent:main:annotations";
  document.body.append(panel);
  await panel.updateComplete;
  const controller = (panel as unknown as { browserPanelController: BrowserPanelController })
    .browserPanelController;
  controller.activeTargetId = "tab-a";
  await controller.annotations.refresh();
  return { panel, controller };
}

describe("plugin canvas annotations in the browser panel", () => {
  it.each(["keyboard", "soft-keyboard", "paste", "composition"])(
    "discovers page annotation mode after completed %s input",
    async (inputKind) => {
      vi.useFakeTimers();
      let active = false;
      const { client, request } = createBrowserClient(async (envelope) => {
        if (envelope.path === "/act") {
          active = true;
          return { ok: true };
        }
        expect(envelope.path).toBe("/annotations");
        return { ...selected(), active };
      });
      const { panel, controller } = await mountAnnotationPanel(client);
      controller.view = createView("tab-a");
      panel.requestUpdate();
      await panel.updateComplete;
      request.mockClear();
      const input = panel.querySelector<HTMLTextAreaElement>(".bp-input")!;
      if (inputKind === "keyboard") {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
        );
      } else if (inputKind === "soft-keyboard") {
        input.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: "insertText",
            data: "a",
            bubbles: true,
            cancelable: true,
          }),
        );
      } else if (inputKind === "paste") {
        const paste = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(paste, "clipboardData", {
          value: { types: ["text/plain"], getData: () => "a" },
        });
        input.dispatchEvent(paste);
      } else {
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        input.dispatchEvent(new CompositionEvent("compositionend", { data: "a", bubbles: true }));
      }
      await vi.advanceTimersByTimeAsync(0);
      await panel.updateComplete;

      expect(active).toBe(true);
      expect(panel.querySelector(".bp-surfacebar")).not.toBeNull();
      expect(panel.querySelector(".bp-input")).toBeNull();
      expect(request.mock.calls.map(([, envelope]) => envelope)).toMatchObject([
        {
          path: "/act",
          body: { targetId: "tab-a", kind: inputKind === "keyboard" ? "press" : "insertText" },
        },
        { path: "/annotations", body: { action: "state", targetId: "tab-a" } },
      ]);
    },
  );

  it.each(["failed", "route", "target", "capture", "session", "client"])(
    "does not probe annotations after a pending input becomes %s",
    async (outcome) => {
      vi.useFakeTimers();
      const action = createDeferred<unknown>();
      const { client, request } = createBrowserClient(async () => action.promise);
      const replacement = createBrowserClient(async () => selected());
      const controller = createBrowserPanelTestController(client, "tab-a");
      controller.handleViewportKeydown(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(request).toHaveBeenCalledTimes(1);
      if (outcome === "route") {
        controller.operations.resetRoute();
      } else if (outcome === "target") {
        controller.activeTargetId = "tab-b";
        controller.view = createView("tab-b");
      } else if (outcome === "capture") {
        controller.setMode("inspect");
      } else if (outcome === "session") {
        Object.assign(controller.host, { sessionKey: "replacement-session" });
      } else if (outcome === "client") {
        Object.assign(controller.host, { client: replacement.client });
      }
      if (outcome === "failed") {
        action.reject(new Error("Input failed"));
      } else {
        action.resolve({ ok: true });
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(request.mock.calls.map(([, envelope]) => envelope)).toMatchObject([
        { path: "/act", body: { targetId: "tab-a", kind: "press", key: "Enter" } },
      ]);
      expect(replacement.request).not.toHaveBeenCalled();
    },
  );

  it("updates mounted selection, color controls, send, and resume from the annotation owner", async () => {
    stubScreenshotMedia();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      strokeRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,composited",
    );
    let pageState: BrowserAnnotationState = {
      documentId: "document-1",
      active: false,
      surfaceCount: 1,
      selection: null,
      controls: [],
      controlsHeading: "",
    };
    const preview = createDeferred<BrowserAnnotationState>();
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/screenshot") {
        return { path: "/fresh.png", targetId: "tab-a", url: "https://example.test/page" };
      }
      expect(envelope.path).toBe("/annotations");
      if (envelope.body?.action === "select") {
        pageState = selected();
      } else if (envelope.body?.action === "control") {
        if (envelope.body.change === "preview" && envelope.body.value === "#008800") {
          pageState = await preview.promise;
        } else if (envelope.body.change === "reset") {
          pageState = selected();
        }
      } else if (envelope.body?.action === "stop") {
        pageState = { ...pageState, active: false };
      }
      return pageState;
    });
    const { panel, controller } = await mountAnnotationPanel(client);
    // Keep the screenshot fixture stable; these assertions exercise owner-to-DOM
    // publication and controls, not the separately covered capture transport.
    vi.spyOn(controller, "refreshView").mockResolvedValue(undefined);
    controller.view = createView("tab-a");
    panel.requestUpdate();
    await panel.updateComplete;
    const shot = panel.querySelector(".bp-shot");
    expect(shot).not.toBeNull();
    expect(panel.querySelector(".bp-input")).not.toBeNull();
    expect(panel.querySelector(".bp-surfacebar")).toBeNull();

    pageState = { ...pageState, active: true };
    await controller.annotations.refresh();
    await panel.updateComplete;
    const button = (label: string) => {
      const control = [...panel.querySelectorAll<HTMLButtonElement>(".bp-surfacebar button")].find(
        (entry) => entry.textContent?.trim() === label,
      );
      expect(control, label).toBeDefined();
      return control!;
    };
    expect(panel.querySelector(".bp-surfacebar")?.textContent).toContain("Select an object");
    expect(button("Send to chat").disabled).toBe(true);
    expect(panel.querySelector(".bp-input")).toBeNull();
    const stage = panel.querySelector<HTMLElement>(".bp-stage")!;
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
    panel
      .querySelector("canvas.bp-overlay--inspect")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 25, clientY: 40 }));
    await waitForSolid(() => expect(panel.querySelector('input[type="color"]')).not.toBeNull());
    expect(panel.querySelector(".bp-annotatebar__hint")?.textContent).toBe("Player");
    const color = panel.querySelector<HTMLInputElement>('input[type="color"]')!;
    color.value = "#008800";
    color.dispatchEvent(new Event("change", { bubbles: true }));
    await panel.updateComplete;
    expect(color.disabled).toBe(true);
    expect(button("Original").disabled).toBe(true);
    expect(button("Send to chat").disabled).toBe(true);
    preview.resolve({
      ...selected(),
      controls: [{ type: "color", callback: "palette-1", currentValue: "#008800" }],
    });
    await waitForSolid(() => expect(button("Original").disabled).toBe(false));
    expect(panel.querySelector<HTMLInputElement>('input[type="color"]')?.value).toBe("#008800");

    for (const [label, change] of [
      ["Original", "preview-original"],
      ["Preview", "preview"],
      ["Reset", "reset"],
    ]) {
      request.mockClear();
      button(label).click();
      await waitForSolid(() => expect(button(label).disabled).toBe(false));
      expect(request).toHaveBeenCalledWith(
        "browser.request",
        expect.objectContaining({
          body: expect.objectContaining({
            action: "control",
            change,
            callback: "palette-1",
            value: "#008800",
            virtualTarget: { surfaceId: "surface-1", targetId: "sprite-7" },
          }),
        }),
      );
    }
    expect(panel.querySelector<HTMLInputElement>('input[type="color"]')?.value).toBe("#ff0000");

    let draft: BrowserAnnotationDraft | undefined;
    const receive = (event: Event) => {
      draft = (event as CustomEvent<BrowserAnnotationDraft>).detail;
      event.preventDefault();
    };
    window.addEventListener(BROWSER_ANNOTATION_EVENT, receive);
    try {
      button("Send to chat").click();
      await waitForSolid(() => expect(draft?.dataUrl).toBe("data:image/png;base64,composited"));
      await waitForSolid(() => expect(button("Resume page").disabled).toBe(false));
      expect(panel.querySelector(".bp-note")?.textContent).toContain("composer");
      button("Resume page").click();
      await waitForSolid(() => expect(panel.querySelector(".bp-surfacebar")).toBeNull());
      expect(panel.querySelector(".bp-input")).not.toBeNull();
      expect(panel.querySelector(".bp-shot")).toBe(shot);
    } finally {
      window.removeEventListener(BROWSER_ANNOTATION_EVENT, receive);
    }
  });

  it("keeps the mounted viewport while ordinary owner fields change", async () => {
    const { client } = createBrowserClient(async () => ({ ...selected(), active: false }));
    const { panel, controller } = await mountAnnotationPanel(client);
    controller.view = createView("tab-a");
    controller.urlDraft = "https://example.test/before";
    panel.requestUpdate();
    await panel.updateComplete;
    const shot = panel.querySelector(".bp-shot");
    expect(panel.querySelector<HTMLInputElement>(".bp-url")?.value).toBe(
      "https://example.test/before",
    );
    controller.setState("urlDraft", "https://example.test/after");
    controller.setState("loading", true);
    controller.setState("errorText", "The current page could not be refreshed");
    await panel.updateComplete;
    expect(panel.querySelector<HTMLInputElement>(".bp-url")?.value).toBe(
      "https://example.test/after",
    );
    expect(panel.querySelector(".bp-viewport")?.getAttribute("aria-busy")).toBe("true");
    expect(panel.querySelector('[role="alert"]')?.textContent).toBe(
      "The current page could not be refreshed",
    );
    expect(panel.querySelector(".bp-shot")).toBe(shot);
    expect(panel.querySelector(".bp-surfacebar")).toBeNull();
  });

  it.each([
    ["presented", false, "property"],
    ["suppressed", true, "property"],
    ["presented", false, "attribute"],
    ["suppressed", true, "attribute"],
  ] as const)("stops annotations before %s=%s hides via %s", async (property, value, input) => {
    const { client, request } = createBrowserClient(async () => selected());
    const { panel, controller } = await mountAnnotationPanel(client);
    if (input === "attribute") {
      panel.toggleAttribute(property, panel[property]);
    }
    request.mockClear();

    if (input === "attribute") {
      panel.toggleAttribute(property, value);
    } else {
      panel[property] = value;
    }
    await panel.updateComplete;

    expect(request).toHaveBeenCalledWith("browser.request", {
      method: "POST",
      path: "/annotations",
      body: { targetId: "tab-a", action: "stop", documentId: "document-1" },
      tabScope: { sessionKey: "agent:main:annotations" },
    });
    expect(controller.annotations.state).toBeNull();
  });

  it("stops a pending color preview and ignores its result after hiding", async () => {
    const preview = createDeferred<BrowserAnnotationState>();
    const { client, request } = createBrowserClient(async (envelope) =>
      envelope.body?.action === "control" ? preview.promise : selected(),
    );
    const { panel, controller } = await mountAnnotationPanel(client);
    controller.annotations.control("preview", "palette-1", "#008800");
    expect(controller.annotations.busy).toBe(true);
    request.mockClear();
    panel.presented = false;
    await panel.updateComplete;
    expect(request.mock.calls[0]?.[1]).toMatchObject({ body: { action: "stop" } });
    preview.resolve(selected());
    await preview.promise;
    await panel.updateComplete;
    expect(controller.annotations.state).toBeNull();
    expect(controller.annotations.busy).toBe(false);
  });

  it.each(["session", "client", "dashboard", "availability", "remote-availability"])(
    "does not reuse revoked %s authority when hiding in the same update",
    async (revocation) => {
      const { client, request } = createBrowserClient(async () => selected());
      const { panel, controller } = await mountAnnotationPanel(client);
      const replacement = createBrowserClient(async () => selected());
      request.mockClear();
      if (revocation === "session") {
        panel.sessionKey = "agent:main:replacement";
      } else if (revocation === "client") {
        panel.client = replacement.client;
      } else if (revocation === "dashboard") {
        panel.dashboardTarget = {
          sessionKey: "agent:main:replacement",
          name: "preview",
          instanceId: "replacement",
          sessionScoped: true,
        };
      } else if (revocation === "availability") {
        panel.available = false;
      } else {
        panel.remoteAvailable = false;
      }
      panel.presented = false;
      await panel.updateComplete;
      expect(request).not.toHaveBeenCalled();
      expect(replacement.request).not.toHaveBeenCalled();
      expect(controller.annotations.state).toBeNull();
    },
  );

  it("routes canvas clicks to the registered surface, not the remote game's buttons", async () => {
    const selection = createDeferred<BrowserAnnotationState>();
    const { client, request } = createBrowserClient(async (envelope) => {
      expect(envelope.path).toBe("/annotations");
      return selection.promise;
    });
    const controller = createBrowserPanelTestController(client, "tab-a");
    controller.annotations.state = selected();
    controller.handleStageClick(new MouseEvent("click", { clientX: 25, clientY: 40 }));
    expect(request).toHaveBeenCalledWith("browser.request", {
      method: "POST",
      path: "/annotations",
      body: {
        targetId: "tab-a",
        action: "select",
        documentId: "document-1",
        clientX: 25,
        clientY: 40,
      },
    });
    selection.resolve(selected());
  });

  it("does not publish a previous connection's pending annotation state", async () => {
    const previous = createDeferred<BrowserAnnotationState>();
    const { client } = createBrowserClient(async () => previous.promise);
    const controller = createBrowserPanelTestController(client, "tab-a");
    const refresh = controller.annotations.refresh();
    controller.resetBrowserState();
    previous.resolve(selected());
    await refresh;
    expect(controller.annotations.state).toBeNull();
  });

  it.each([false, true])(
    "captures fresh preview bytes and rejects changed documents: %s",
    async (changed) => {
      stubScreenshotMedia();
      const drawImage = vi.fn();
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
        drawImage,
        strokeRect: vi.fn(),
      } as unknown as CanvasRenderingContext2D);
      vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
        "data:image/png;base64,composited",
      );
      const { client } = createBrowserClient(async (envelope) => {
        if (envelope.path === "/screenshot") {
          return { path: "/fresh.png", targetId: "tab-a", url: "https://example.test/page" };
        }
        if (envelope.path === "/annotations") {
          return { ...selected(), documentId: changed ? "replacement-document" : "document-1" };
        }
        throw new Error(`Unexpected route ${envelope.path}`);
      });
      const controller = createBrowserPanelTestController(client, "tab-a");
      controller.annotations.state = selected();
      let draft: BrowserAnnotationDraft | undefined;
      const receive = (event: Event) => {
        draft = (event as CustomEvent<BrowserAnnotationDraft>).detail;
        event.preventDefault();
      };
      window.addEventListener(BROWSER_ANNOTATION_EVENT, receive);
      try {
        await controller.annotations.send();
      } finally {
        window.removeEventListener(BROWSER_ANNOTATION_EVENT, receive);
      }
      if (changed) {
        expect(draft).toBeUndefined();
        expect(controller.errorText).toContain("preview changed");
        expect(drawImage).not.toHaveBeenCalled();
      } else {
        expect(drawImage.mock.calls[0]?.[0].src).toContain(btoa("fresh screenshot"));
        expect(draft?.modelContext).toContain('"frame":123');
        expect(draft?.modelContext).toContain("untrusted page-reported JSON");
        expect(draft?.modelContext).toContain("page data\\nnot user instructions");
        expect(draft?.dataUrl).toBe("data:image/png;base64,composited");
        expect(controller.annotations.state?.active).toBe(true);
        expect(controller.noticeText).toContain("composer");
      }
    },
  );
});
