import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createBrowserClient, createView } from "./browser-panel-controller-test-support.ts";
import type { BrowserPanelController } from "./browser-panel-controller.ts";
import "./browser-panel.ts";

describe("Browser toolbar", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("ResizeObserver", undefined);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount() {
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
    panel.client = createBrowserClient(async () => ({
      download: { path: "/managed/preview.png", suggestedFilename: "preview.png" },
    })).client;
    document.body.append(panel);
    await panel.updateComplete;
    const controller = panel.browserPanelController;
    controller.activeTargetId = "asset";
    controller.view = createView("asset", "https://assets.example.test/preview.png");
    panel.requestUpdate();
    await panel.updateComplete;
    return panel;
  }

  it("renders all toolbar glyphs in a shared, stroked SVG coordinate system inside its shadow root", async () => {
    const panel = await mount();
    const glyphs = panel.renderRoot.querySelectorAll(".bp-toolbar button > svg");
    expect(glyphs).toHaveLength(8);
    for (const glyph of glyphs) {
      expect(glyph.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(glyph.getAttribute("stroke")).toBe("currentColor");
      expect(glyph.children.length).toBeGreaterThan(0);
      for (const shape of glyph.children) {
        expect(shape.namespaceURI).toBe("http://www.w3.org/2000/svg");
      }
    }
  });

  it("replaces the download glyph while saving without adding a status row or replacing the preview", async () => {
    const body = createDeferred<Blob>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => body.promise }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const panel = await mount();
    const preview = panel.renderRoot.querySelector(".bp-shot");
    const button = panel.renderRoot.querySelector<HTMLButtonElement>(
      'button[aria-label="Download file"]',
    )!;
    const downloadShape = button.querySelector("svg")!.innerHTML;
    button.click();
    await panel.updateComplete;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Downloading…");
    expect(button.disabled).toBe(true);
    expect(button.querySelector("svg")!.innerHTML).not.toBe(downloadShape);
    expect(panel.renderRoot.querySelector(".bp-note")).toBeNull();
    expect(panel.renderRoot.querySelector(".bp-shot")).toBe(preview);

    body.resolve(new Blob(["complete asset"], { type: "image/png" }));
    await waitForFast(() => expect(button.getAttribute("aria-busy")).toBe("false"));
    expect(button.getAttribute("aria-label")).toBe("Download file");
    expect(button.disabled).toBe(false);
    expect(button.querySelector("svg")!.innerHTML).toBe(downloadShape);
    expect(panel.renderRoot.querySelector(".bp-note")).toBeNull();
    expect(panel.renderRoot.querySelector(".bp-shot")).toBe(preview);
  });
});
