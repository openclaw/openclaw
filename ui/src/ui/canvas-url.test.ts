import { describe, expect, it } from "vitest";
import { resolveCanvasIframeUrl } from "./canvas-url.ts";

describe("resolveCanvasIframeUrl", () => {
  it("fails closed for protected canvas and a2ui paths when the scoped host is missing", () => {
    expect(
      resolveCanvasIframeUrl("/__openclaw__/canvas/documents/cv_demo/index.html"),
    ).toBeUndefined();
    expect(resolveCanvasIframeUrl("/__openclaw__/a2ui/apps/demo/index.html")).toBeUndefined();
  });

  it("fails closed for protected canvas paths when the scoped host is unscoped", () => {
    expect(
      resolveCanvasIframeUrl(
        "/__openclaw__/canvas/documents/cv_demo/index.html",
        "http://127.0.0.1:19003/__openclaw__/canvas",
      ),
    ).toBeUndefined();
    expect(
      resolveCanvasIframeUrl(
        "/__openclaw__/canvas/documents/cv_demo/index.html",
        "http://127.0.0.1:19003/__openclaw__/cap",
      ),
    ).toBeUndefined();
  });

  it("rewrites safe canvas paths through the scoped canvas host", () => {
    expect(
      resolveCanvasIframeUrl(
        "/__openclaw__/canvas/documents/cv_demo/index.html",
        "http://127.0.0.1:19003/__openclaw__/cap/cap_123",
      ),
    ).toBe(
      "http://127.0.0.1:19003/__openclaw__/cap/cap_123/__openclaw__/canvas/documents/cv_demo/index.html",
    );
  });

  it("rejects non-canvas same-origin paths", () => {
    expect(resolveCanvasIframeUrl("/not-canvas/snake.html")).toBeUndefined();
  });

  it("rejects absolute external URLs", () => {
    expect(resolveCanvasIframeUrl("https://example.com/evil.html")).toBeUndefined();
  });

  it("allows absolute external URLs only when explicitly enabled", () => {
    expect(resolveCanvasIframeUrl("https://example.com/embed.html?x=1#y", undefined, true)).toBe(
      "https://example.com/embed.html?x=1#y",
    );
  });

  it("rejects file URLs", () => {
    expect(resolveCanvasIframeUrl("file:///tmp/snake.html")).toBeUndefined();
  });
});
