import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { PluginUiFrameController } from "./plugin-ui-document.ts";

const cleanups: Array<() => void> = [];

async function loadDocument(response: Response, sandbox = "allow-scripts allow-same-origin") {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  const updated = createDeferred<void>();
  const frame = new PluginUiFrameController(() => updated.resolve());
  cleanups.push(() => frame.clear());
  frame.document.ensure("document-key", "/plugins/external/panel", "document-nonce", sandbox);
  await updated.promise;
  return frame.document;
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
});

describe("plugin UI documents", () => {
  it("does not build an action document from downloadable HTML", async () => {
    const controller = await loadDocument(
      new Response("<!doctype html><main>Download only</main>", {
        headers: {
          "Content-Disposition": 'attachment; filename="panel.html"',
          "Content-Type": "text/html",
        },
      }),
      "allow-scripts",
    );

    expect(controller.current).toBeNull();
    expect(controller.errorKey).toBe("document-key");
  });

  it("preserves a plugin base URL and route-origin CSP inside the bridge document", async () => {
    const controller = await loadDocument(
      new Response('<!doctype html><base href="../assets/"><script src="panel.js"></script>', {
        headers: {
          "Content-Security-Policy": "default-src 'self'; script-src 'self'",
          "Content-Type": "text/html",
        },
      }),
    );

    const parsed = new DOMParser().parseFromString(controller.current?.srcdoc ?? "", "text/html");
    expect(parsed.querySelectorAll("base")).toHaveLength(1);
    expect(parsed.querySelector("base")?.href).toBe(
      new URL("/plugins/assets/", window.location.href).href,
    );
    const policy = parsed.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(policy?.getAttribute("content")).toBe(
      `default-src ${window.location.origin}; script-src ${window.location.origin}`,
    );
    const bridge = parsed.querySelector("script[data-openclaw-plugin-ui-nonce]");
    expect(bridge?.getAttribute("data-openclaw-plugin-ui-nonce")).toBe("document-nonce");
    const headChildren = Array.from(parsed.head.children);
    expect(headChildren.indexOf(policy!)).toBeLessThan(headChildren.indexOf(bridge!));
  });

  it("applies a response CSP sandbox to the outer action frame", async () => {
    const controller = await loadDocument(
      new Response("<!doctype html><main>Plugin panel</main>", {
        headers: {
          "Content-Security-Policy": "sandbox allow-scripts; default-src 'self'",
          "Content-Type": "text/html",
        },
      }),
    );

    expect(controller.current?.sandbox).toBe("allow-scripts");
    const parsed = new DOMParser().parseFromString(controller.current?.srcdoc ?? "", "text/html");
    expect(
      parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
    ).toBe(`default-src ${window.location.origin}`);
  });

  it.each([
    ["a CSP sandbox that disables scripts", "sandbox; default-src 'self'"],
    [
      "comma-combined response CSP policies",
      "default-src 'self' 'unsafe-inline'; img-src *, script-src 'none'",
    ],
    ["a CSP embedding denial", "frame-ancestors 'none'; default-src 'self'"],
    ["a CSP route-base denial", "base-uri 'none'; default-src 'self'"],
    ["a CSP script denial", "default-src 'self'; script-src 'none'"],
    [
      "a nonce-bound strict-dynamic script policy",
      "script-src 'nonce-plugin' 'strict-dynamic' 'self'",
    ],
  ])("does not build the action document for %s", async (_caseName, policy) => {
    const controller = await loadDocument(
      new Response("<!doctype html><main>Plugin panel</main>", {
        headers: {
          "Content-Security-Policy": policy,
          "Content-Type": "text/html",
        },
      }),
    );

    expect(controller.current).toBeNull();
    expect(controller.errorKey).toBe("document-key");
  });
});
