import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { createAgentSelectionCapability } from "./agent-selection.ts";
import {
  applyControlUiFaviconStatus,
  applyControlUiPresentation,
} from "./control-ui-environment-presentation.runtime.ts";
import { connectControlUiFavicon } from "./control-ui-favicon-status.runtime.ts";
import { client, createGatewayHarness } from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "./theme-branding.ts";

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
  let previousThemeMascot: string | undefined;
  let previousBranding: ReturnType<typeof currentThemeBranding>;
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
    previousThemeMascot = document.documentElement.dataset.themeMascot;
    previousBranding = currentThemeBranding();
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.themeMode = "dark";
    setCurrentThemeBranding({ mascot: "claw", critters: [] });
    document.documentElement.dataset.themeMascot = "claw";
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
    setCurrentThemeBranding({ mascot: "claw", critters: [] });
    document.documentElement.dataset.themeMascot = "claw";
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
    if (previousThemeMascot === undefined) {
      delete document.documentElement.dataset.themeMascot;
    } else {
      document.documentElement.dataset.themeMascot = previousThemeMascot;
    }
    setCurrentThemeBranding(previousBranding);
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

  it("reuses palette reads through session publications while retaining retries and presentation changes", async () => {
    let row: GatewaySessionRow = {
      key: "agent:main:favicon-palette",
      sessionId: "favicon-palette",
      kind: "direct",
      agentId: "main",
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["favicon-run"],
      updatedAt: 1,
    };
    const harness = createGatewayHarness(
      client(async (method) => {
        if (method === "sessions.list") {
          return sessionsResult([row], 1);
        }
        throw new Error(`Unexpected favicon fixture request: ${method}`);
      }),
    );
    harness.update({ hello: gatewayHelloForMethods(["sessions.list"], ["operator.read"]) });
    const selection = createAgentSelectionCapability(harness.gateway, {
      state: { agentsList: null },
      subscribe: () => () => {},
    });
    const sessions = createSessionCapability(harness.gateway, selection, {
      rosterCache: { read: async () => null, write: () => {} },
    });
    const overlays = createApplicationOverlays(harness.gateway);
    const shell = document.createElement("div");
    document.body.append(shell);
    let disconnect: (() => void) | undefined;
    const notified = vi.fn();
    const stopNotifications = sessions.subscribe(notified);
    const publishRow = (patch: Partial<GatewaySessionRow>) => {
      row = { ...row, ...patch, updatedAt: (row.updatedAt ?? 0) + 1 };
      expect(sessions.captureReconcile()(row, undefined, { resultAgentId: "main" })).toBe(true);
    };
    const expectDot = (color: string) =>
      vi.waitFor(() =>
        expect(svgDocument().documentElement.lastElementChild?.getAttribute("fill")).toBe(color),
      );
    const changePresentation = async (change: () => void) => {
      const changed = createDeferred();
      const observer = new MutationObserver(() => changed.resolve());
      observer.observe(svgIcon, { attributes: true, attributeFilter: ["href"] });
      try {
        change();
        await changed.promise;
      } finally {
        observer.disconnect();
      }
    };
    const themeStyle = document.createElement("style");
    themeStyle.textContent = `
      :root { --primary: rgb(180, 20, 40); --primary-foreground: rgb(250, 250, 250); }
      :root[data-theme="favicon-neutral"] { --primary: rgb(190, 30, 50); --primary-foreground: rgb(240, 240, 240); }
    `;
    document.head.append(themeStyle);
    try {
      await sessions.refresh({ agentId: "main", force: true });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Transient favicon read"));
      disconnect = connectControlUiFavicon(shell, {
        gateway: harness.gateway,
        agentSelection: selection,
        sessions,
        overlays,
      });
      await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
      const styleReads = vi.spyOn(globalThis, "getComputedStyle");
      publishRow({ label: "Retry the failed icon on the next session publication" });
      expect(styleReads).not.toHaveBeenCalled();
      await expectDot("rgb(80, 120, 160)");
      const workingHref = svgIcon.href;
      notified.mockClear();
      styleReads.mockClear();
      for (const label of [
        "First metadata update",
        "Second metadata update",
        "Third metadata update",
      ]) {
        publishRow({ label });
      }
      expect(notified).toHaveBeenCalledTimes(3);
      expect(sessions.state.result?.sessions[0]?.label).toBe("Third metadata update");
      expect(styleReads).not.toHaveBeenCalled();
      expect(svgIcon.href).toBe(workingHref);

      document.documentElement.style.setProperty("--accent", "rgb(70, 140, 190)");
      await expectDot("rgb(70, 140, 190)");
      document.documentElement.style.setProperty("--info", "rgb(20, 100, 180)");
      document.documentElement.dataset.theme = "light";
      document.documentElement.dataset.themeMode = "light";
      await expectDot("rgb(20, 100, 180)");
      applyControlUiPresentation({ environment: { label: "Preview", color: "blue" } });
      await vi.waitFor(() =>
        expect(svgDocument().querySelector('path[fill="rgb(40, 100, 180)"]')).not.toBeNull(),
      );
      await expectDot("rgb(20, 100, 180)");
      await changePresentation(() => {
        setCurrentThemeBranding({ mascot: "none", critters: [] });
        document.documentElement.dataset.themeMascot = "none";
      });
      expect(svgDocument().querySelector("rect")?.getAttribute("fill")).toBe("rgb(180, 20, 40)");
      expect(svgDocument().querySelector("path")?.getAttribute("stroke")).toBe(
        "rgb(250, 250, 250)",
      );
      expect(svgDocument().querySelector('path[fill="rgb(40, 100, 180)"]')).toBeNull();
      expect(svgDocument().documentElement.lastElementChild?.getAttribute("fill")).toBe(
        "rgb(20, 100, 180)",
      );
      await changePresentation(() => {
        document.documentElement.dataset.theme = "favicon-neutral";
      });
      expect(svgDocument().querySelector("rect")?.getAttribute("fill")).toBe("rgb(190, 30, 50)");
      expect(svgDocument().querySelector("path")?.getAttribute("stroke")).toBe(
        "rgb(240, 240, 240)",
      );
      await changePresentation(() => {
        document.documentElement.style.setProperty("--primary", "rgb(160, 40, 60)");
      });
      expect(svgDocument().querySelector("rect")?.getAttribute("fill")).toBe("rgb(160, 40, 60)");
      await changePresentation(() => {
        setCurrentThemeBranding({ mascot: "claw", critters: [] });
        document.documentElement.dataset.themeMascot = "claw";
      });
      expect(svgDocument().querySelector('path[fill="rgb(40, 100, 180)"]')).not.toBeNull();
      applyControlUiPresentation({ environment: null });
      await vi.waitFor(() =>
        expect(svgDocument().querySelectorAll("animate, animateTransform").length).toBeGreaterThan(
          0,
        ),
      );
      await expectDot("rgb(20, 100, 180)");
      publishRow({ status: "failed", hasActiveRun: false, activeRunIds: [] });
      expectOriginals();
      await changePresentation(() => {
        setCurrentThemeBranding({ mascot: "none", critters: [] });
        document.documentElement.dataset.themeMascot = "none";
      });
      expect(svgDocument().querySelector("rect")?.getAttribute("fill")).toBe("rgb(190, 30, 50)");
      expect(svgDocument().querySelector("circle")).toBeNull();
      expect(pngIcon.href).toBe(svgIcon.href);
      await changePresentation(() => {
        setCurrentThemeBranding({ mascot: "claw", critters: [] });
        document.documentElement.dataset.themeMascot = "claw";
      });
      expectOriginals();
    } finally {
      disconnect?.();
      stopNotifications();
      overlays.dispose();
      sessions.dispose();
      selection.dispose();
      shell.remove();
      themeStyle.remove();
    }
  });

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
