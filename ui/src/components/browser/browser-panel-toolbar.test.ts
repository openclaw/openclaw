import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { stubScreenshotMedia } from "./browser-panel-controller-test-support.ts";
import { createBrowserPageClient } from "./test-helpers/browser-page.ts";
import "./browser-panel.ts";

describe("Browser toolbar", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount() {
    stubScreenshotMedia();
    const panel = document.createElement("openclaw-browser-panel");
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.client = createBrowserPageClient(
      "asset",
      "https://assets.example.test/preview.png",
    ).client;
    mountSolid(() => panel);
    await waitForSolid(() => expect(panel.querySelector(".bp-shot")).not.toBeNull());
    return panel;
  }

  it("renders all toolbar glyphs in a shared, stroked SVG coordinate system inside its light-DOM host", async () => {
    const panel = await mount();
    const glyphs = panel.querySelectorAll(".bp-toolbar button > svg");
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

  it("openclaw-browser-panel Download renders the Gateway error message and HTTP status", async () => {
    const panel = await mount();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: { message: "Unauthorized", type: "unauthorized" } },
            { status: 401 },
          ),
        ),
    );
    panel.querySelector<HTMLButtonElement>('button[aria-label="Download file"]')!.click();
    await waitForSolid(() => expect(panel.textContent).toContain("HTTP 401: Unauthorized"));
  });

  it("replaces the download glyph while saving without adding a status row or replacing the preview", async () => {
    const panel = await mount();
    const body = createDeferred<Blob>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => body.promise }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const preview = panel.querySelector(".bp-shot");
    const button = panel.querySelector<HTMLButtonElement>('button[aria-label="Download file"]')!;
    const downloadShape = button.querySelector("svg")!.innerHTML;
    button.click();
    await panel.updateComplete;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Downloading…");
    expect(button.disabled).toBe(true);
    expect(button.querySelector("svg")!.innerHTML).not.toBe(downloadShape);
    expect(panel.querySelector(".bp-note")).toBeNull();
    expect(panel.querySelector(".bp-shot")).toBe(preview);

    body.resolve(new Blob(["complete asset"], { type: "image/png" }));
    await waitForSolid(() => expect(button.getAttribute("aria-busy")).toBe("false"));
    expect(button.getAttribute("aria-label")).toBe("Download file");
    expect(button.disabled).toBe(false);
    expect(button.querySelector("svg")!.innerHTML).toBe(downloadShape);
    expect(panel.querySelector(".bp-note")).toBeNull();
    expect(panel.querySelector(".bp-shot")).toBe(preview);
  });
});
