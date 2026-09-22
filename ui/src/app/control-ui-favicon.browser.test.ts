import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { createDeferred } from "../../../test/helpers/promise.ts";
import {
  applyControlUiFaviconStatus,
  applyControlUiPresentation,
} from "./control-ui-environment-presentation.runtime.ts";

let faviconSvg: string;
beforeAll(async () => {
  // Vitest serves its own /favicon.svg; load the shipped asset from the UI root.
  faviconSvg = await commands.readFile("public/favicon.svg", "utf8");
});

describe("favicon presentation ownership", () => {
  let previousIcons: HTMLLinkElement[];
  let previousTitle: string;
  let previousStyle: string | null;
  let previousTheme: string | undefined;
  let previousThemeMode: string | undefined;
  let svgIcon: HTMLLinkElement;
  let pngIcon: HTMLLinkElement;
  let originals: [[string, string], [string, string]];

  beforeEach(() => {
    previousIcons = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'));
    previousIcons.forEach((icon) => icon.remove());
    previousTitle = document.title;
    previousStyle = document.documentElement.getAttribute("style");
    previousTheme = document.documentElement.dataset.theme;
    previousThemeMode = document.documentElement.dataset.themeMode;
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.themeMode = "dark";
    for (const [name, value] of [
      ["--warn", "rgb(210, 150, 60)"],
      ["--accent", "rgb(80, 120, 160)"],
      ["--ok", "rgb(100, 180, 120)"],
      ["--muted", "rgb(130, 130, 130)"],
      ["--bg", "rgb(240, 240, 240)"],
      ["--control-ui-environment-blue", "rgb(40, 100, 180)"],
    ] as const) {
      document.documentElement.style.setProperty(name, value);
    }
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    originals = [
      [`data:image/svg+xml,${encodeURIComponent(faviconSvg)}`, "image/svg+xml"],
      [canvas.toDataURL("image/png"), "image/png"],
    ];
    const createIcon = ([href, type]: [string, string]) => {
      const icon = document.createElement("link");
      icon.rel = "icon";
      icon.setAttribute("href", href);
      icon.setAttribute("type", type);
      document.head.append(icon);
      return icon;
    };
    svgIcon = createIcon(originals[0]);
    pngIcon = createIcon(originals[1]);
  });

  afterEach(() => {
    applyControlUiFaviconStatus("idle");
    applyControlUiPresentation({ environment: null });
    svgIcon.remove();
    pngIcon.remove();
    document.head.append(...previousIcons);
    document.title = previousTitle;
    if (previousStyle === null) {
      document.documentElement.removeAttribute("style");
    } else {
      document.documentElement.setAttribute("style", previousStyle);
    }
    if (previousTheme === undefined) {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = previousTheme;
    }
    if (previousThemeMode === undefined) {
      delete document.documentElement.dataset.themeMode;
    } else {
      document.documentElement.dataset.themeMode = previousThemeMode;
    }
    vi.restoreAllMocks();
  });

  function expectOriginals() {
    [svgIcon, pngIcon].forEach((icon, index) => {
      expect([icon.getAttribute("href"), icon.getAttribute("type")]).toEqual(originals[index]);
      expect(icon.hasAttribute("data-openclaw-original-favicon")).toBe(false);
    });
  }

  function svgDocument() {
    return new DOMParser().parseFromString(
      decodeURIComponent(svgIcon.href.slice("data:image/svg+xml,".length)),
      "image/svg+xml",
    );
  }

  it("updates both icon formats and restores their exact originals when idle without changing the title", async () => {
    applyControlUiFaviconStatus("working");
    await vi.waitFor(() => {
      for (const [icon, [href, type]] of [
        [svgIcon, originals[0]],
        [pngIcon, originals[1]],
      ] as const) {
        expect(icon.getAttribute("href")).not.toBe(href);
        expect(icon.type).toBe(type);
      }
    });
    for (const icon of [svgIcon, pngIcon]) {
      const image = new Image();
      image.src = icon.href;
      await image.decode();
      expect(image.naturalWidth).toBe(32);
    }
    const animations = (svg: Document) =>
      Array.from(svg.querySelectorAll("animate, animateTransform"), (animation) =>
        new XMLSerializer().serializeToString(animation),
      );
    const original = new DOMParser().parseFromString(faviconSvg, "image/svg+xml");
    expect(animations(svgDocument())).toEqual(animations(original));
    expect(animations(original).length).toBeGreaterThan(0);
    expect(document.title).toBe(previousTitle);
    applyControlUiFaviconStatus("idle");
    expectOriginals();
  });

  it("keeps the original links when SVG and PNG sources cannot be decoded", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    svgIcon.href = "data:image/svg+xml,invalid";
    pngIcon.href = "data:image/png,invalid";
    applyControlUiFaviconStatus("working");
    await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(2));
    expect(svgIcon.href).toBe("data:image/svg+xml,invalid");
    expect(pngIcon.href).toBe("data:image/png,invalid");
  });

  it("preserves each active presentation when the environment or status is independently removed", async () => {
    const environment = { label: "Preview", color: "blue" } as const;
    applyControlUiPresentation({ environment });
    const environmentHref = svgIcon.href;
    applyControlUiFaviconStatus("attention");
    await vi.waitFor(() => {
      expect(svgIcon.href).not.toBe(environmentHref);
      expect(svgDocument().documentElement.lastElementChild?.getAttribute("fill")).toBe(
        "rgb(210, 150, 60)",
      );
    });
    const environmentWithStatus = svgIcon.href;
    applyControlUiPresentation({ environment: null });
    await vi.waitFor(() => {
      expect(svgIcon.href).not.toBe(environmentWithStatus);
      expect(svgDocument().querySelectorAll("animate, animateTransform").length).toBeGreaterThan(0);
      expect(svgDocument().documentElement.lastElementChild?.getAttribute("fill")).toBe(
        "rgb(210, 150, 60)",
      );
      expect(pngIcon.type).toBe("image/png");
    });
    applyControlUiPresentation({ environment });
    applyControlUiFaviconStatus("idle");
    expect(svgIcon.href).toBe(environmentHref);
    expect(pngIcon.href).toBe(environmentHref);
    expect(svgIcon.hasAttribute("data-openclaw-original-favicon")).toBe(true);
    applyControlUiPresentation({ environment: null });
    expectOriginals();
  });

  it.each(["resolve", "reject"])(
    "keeps the current attention icon when an earlier composition later %ss",
    async (settlement) => {
      const earlier = createDeferred<Response>();
      const current = createDeferred<Response>();
      vi.spyOn(globalThis, "fetch")
        .mockReturnValueOnce(earlier.promise)
        .mockReturnValueOnce(current.promise);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      applyControlUiFaviconStatus("attention");
      applyControlUiFaviconStatus("idle");
      applyControlUiFaviconStatus("attention");
      current.resolve(new Response(faviconSvg.replace("<svg", '<svg data-generation="current"')));
      await vi.waitFor(() => {
        expect(svgDocument().querySelector('[data-generation="current"]')).not.toBeNull();
      });
      const currentHref = svgIcon.href;
      if (settlement === "resolve") {
        earlier.resolve(new Response(faviconSvg));
      } else {
        earlier.reject(new Error("Earlier asset request failed"));
      }
      await earlier.promise.catch(() => undefined);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      expect(svgIcon.href).toBe(currentHref);
    },
  );

  it("does not publish delayed SVG composition after returning to idle", async () => {
    const response = createDeferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    applyControlUiFaviconStatus("attention");
    expect(fetchSpy).toHaveBeenCalled();
    applyControlUiFaviconStatus("idle");
    response.resolve(new Response(faviconSvg, { headers: { "Content-Type": "image/svg+xml" } }));
    await response.promise;
    // The browser completes the response and its composition microtasks before painting.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expectOriginals();
  });
});
