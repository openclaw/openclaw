import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  openBrowserActions,
  stubScreenshotMedia,
} from "./browser-panel-controller-test-support.ts";
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
    const menu = await openBrowserActions(panel);
    const glyphs = [
      ...panel.querySelectorAll(".bp-toolbar button > svg"),
      ...menu.querySelectorAll('[role="menuitem"] svg'),
    ];
    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of glyphs) {
      expect(glyph.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(glyph.getAttribute("stroke")).toBe("currentColor");
      expect(glyph.children.length).toBeGreaterThan(0);
      for (const shape of glyph.children) {
        expect(shape.namespaceURI).toBe("http://www.w3.org/2000/svg");
      }
    }
  });

  it("retires replaced favicon requests without replacing the address draft or focus", async () => {
    const panel = await mount();
    const input = panel.querySelector<HTMLInputElement>(".bp-url")!;
    input.focus();
    input.value = "https://draft.example.test/uncommitted";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await panel.updateComplete;
    input.setSelectionRange(8, 13);
    const toolbar = panel.querySelector(".bp-toolbar");
    const retired = createDeferred<string | null>();
    const current = createDeferred<string | null>();
    const firstFetcher = vi.fn(() => retired.promise);
    const currentFetcher = vi.fn(() => current.promise);
    panel.fetchFavicon = firstFetcher;
    await waitForSolid(() => expect(firstFetcher).toHaveBeenCalledOnce());
    panel.fetchFavicon = currentFetcher;
    await waitForSolid(() => expect(currentFetcher).toHaveBeenCalledOnce());
    expect(panel.querySelector(".bp-toolbar-favicon img")).toBeNull();

    current.resolve("data:image/png;base64,Y3VycmVudA==");
    await waitForSolid(() =>
      expect(panel.querySelector(".bp-toolbar-favicon img")?.getAttribute("src")).toBe(
        "data:image/png;base64,Y3VycmVudA==",
      ),
    );
    retired.resolve("data:image/png;base64,cmV0aXJlZA==");
    await retired.promise;
    await panel.updateComplete;
    expect(panel.querySelector(".bp-toolbar-favicon img")?.getAttribute("src")).toBe(
      "data:image/png;base64,Y3VycmVudA==",
    );
    expect(panel.querySelector(".bp-toolbar")).toBe(toolbar);
    expect(panel.querySelector(".bp-url")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("https://draft.example.test/uncommitted");
    expect([input.selectionStart, input.selectionEnd]).toEqual([8, 13]);

    panel.querySelector(".bp-toolbar-favicon img")!.dispatchEvent(new Event("error"));
    await waitForSolid(() => expect(panel.querySelector(".bp-toolbar-favicon img")).toBeNull());
    expect(panel.querySelector(".bp-toolbar-favicon svg")).not.toBeNull();
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
    (await openBrowserActions(panel))
      .querySelector<HTMLElement>('[aria-label="Download file"]')!
      .click();
    await waitForSolid(() => expect(panel.textContent).toContain("HTTP 401: Unauthorized"));
  });

  it("replaces the download glyph while saving without adding a status row or replacing the preview", async () => {
    const panel = await mount();
    const body = createDeferred<Blob>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: () => body.promise }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const preview = panel.querySelector(".bp-shot");
    const menu = await openBrowserActions(panel);
    let button = menu.querySelector<HTMLElement>('[aria-label="Download file"]')!;
    const downloadShape = button.querySelector("svg")!.innerHTML;
    button.click();
    await panel.updateComplete;
    await openBrowserActions(panel);
    button = menu.querySelector<HTMLElement>('[aria-label="Downloading…"]')!;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Downloading…");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.querySelector("svg")!.innerHTML).not.toBe(downloadShape);
    expect(panel.querySelector(".bp-note")).toBeNull();
    expect(panel.querySelector(".bp-shot")).toBe(preview);

    body.resolve(new Blob(["complete asset"], { type: "image/png" }));
    await waitForSolid(() => {
      button = menu.querySelector<HTMLElement>('[aria-label="Download file"]')!;
      expect(button?.getAttribute("aria-busy")).toBe("false");
    });
    expect(button.getAttribute("aria-label")).toBe("Download file");
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.querySelector("svg")!.innerHTML).toBe(downloadShape);
    expect(panel.querySelector(".bp-note")).toBeNull();
    expect(panel.querySelector(".bp-shot")).toBe(preview);
  });
});
