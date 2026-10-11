import type { BrowserAnnotationState } from "openclaw/plugin-sdk/browser-annotations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { BROWSER_ANNOTATION_EVENT, type BrowserAnnotationDraft } from "./browser-annotation.ts";
import {
  createBrowserClient,
  createBrowserPanelTestController,
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
  it.each([
    ["presented", false],
    ["suppressed", true],
  ] as const)("stops annotations before %s hides an embedded panel", async (property, value) => {
    const { client, request } = createBrowserClient(async () => selected());
    const { panel, controller } = await mountAnnotationPanel(client);
    request.mockClear();

    panel[property] = value;
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
