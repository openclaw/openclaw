import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import { loadSettings, patchSettings, saveSettings, settingsKeyForGateway } from "./settings.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "./theme-branding.ts";
import type { ThemeMode } from "./theme.ts";

type ColorMode = "dark" | "light";

// Model root-document inputs, not an iOS suspension or the reporting iframe.
// Raw preference changes and MQL delivery are separate so resume can precede
// a queued change event (or happen without any root MQL event at all).
function createBrowserInputs(initialMode: ColorMode, legacy = false) {
  let rawMode = initialMode;
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => visibility === "hidden");
  const queries = new Map<string, ReturnType<typeof createQuery>>();
  function createQuery(media: string) {
    const target = new EventTarget();
    return {
      media,
      get matches() {
        return media === "(prefers-color-scheme: light)" && rawMode === "light";
      },
      addEventListener: legacy ? undefined : target.addEventListener.bind(target),
      removeEventListener: legacy ? undefined : target.removeEventListener.bind(target),
      addListener: (listener: EventListener) => target.addEventListener("change", listener),
      removeListener: (listener: EventListener) => target.removeEventListener("change", listener),
      dispatchEvent: target.dispatchEvent.bind(target),
    };
  }
  vi.stubGlobal("matchMedia", (media: string) => {
    let query = queries.get(media);
    if (!query) {
      query = createQuery(media);
      queries.set(media, query);
    }
    return query;
  });
  return {
    setRawMode(mode: ColorMode) {
      rawMode = mode;
    },
    deliverChange(eventMode = rawMode) {
      queries.get("(prefers-color-scheme: light)")?.dispatchEvent(
        Object.assign(new Event("change"), {
          media: "(prefers-color-scheme: light)",
          matches: eventMode === "light",
        }),
      );
    },
    setVisibility(next: DocumentVisibilityState, dispatch = true) {
      visibility = next;
      if (dispatch) {
        document.dispatchEvent(new Event("visibilitychange"));
      }
    },
  };
}

let applicationTheme: ReturnType<typeof createApplicationTheme> | undefined;
let restoreDocument: () => void;

beforeEach(() => {
  const root = document.documentElement;
  const attributes = [...root.attributes].map(({ name, value }) => [name, value] as const);
  const headChildren = new Set(document.head.children);
  const branding = currentThemeBranding();
  restoreDocument = () => {
    for (const name of root.getAttributeNames()) {
      root.removeAttribute(name);
    }
    for (const [name, value] of attributes) {
      root.setAttribute(name, value);
    }
    for (const child of document.head.querySelectorAll(":scope > *")) {
      if (!headChildren.has(child)) {
        child.remove();
      }
    }
    setCurrentThemeBranding(branding);
  };
  // Keep a prior test's mascot removal from starting unrelated favicon work.
  root.dataset.themeMascot = "claw";
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  applicationTheme?.dispose();
  applicationTheme = undefined;
  restoreDocument();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mountTheme(rawMode: ColorMode, mode: ThemeMode = "system", legacy = false) {
  const browser = createBrowserInputs(rawMode, legacy);
  const { gateway } = createApplicationGateway();
  saveSettings({
    ...loadSettings(gateway.connection.gatewayUrl),
    theme: "claw",
    themeMode: mode,
  });
  const theme = createApplicationTheme(loadSettings(gateway.connection.gatewayUrl), gateway);
  applicationTheme = theme;
  return { browser, theme };
}

function expectPresentation(
  theme: ReturnType<typeof createApplicationTheme>,
  mode: ColorMode,
  palette: { id: string; value: string } = { id: "claw", value: mode },
) {
  const root = document.documentElement;
  expect(root.dataset.themeId).toBe(palette.id);
  expect(root.dataset.theme).toBe(palette.value);
  expect(root.dataset.themeMode).toBe(mode);
  expect(root.dataset.themeResolved).toBe(mode);
  expect(root.classList.contains("wa-light")).toBe(mode === "light");
  expect(root.classList.contains("wa-dark")).toBe(mode === "dark");
  expect(root.style.colorScheme).toBe(mode);
  expect(theme.resolvedMode).toBe(mode);
}

describe("System theme admission and foreground reconciliation", () => {
  it.each([false, true])(
    "repairs a visible transient Light before queued MQL delivery on return (legacy: %s)",
    (legacy) => {
      const { browser, theme } = mountTheme("dark", "system", legacy);
      expectPresentation(theme, "dark");
      browser.setRawMode("light");
      browser.deliverChange();
      expectPresentation(theme, "light");

      browser.setVisibility("hidden");
      browser.setRawMode("dark");
      browser.setVisibility("visible");
      // No MQL delivery, preference refresh, or queued task may be needed here.
      expectPresentation(theme, "dark");
      browser.deliverChange("light");
      expectPresentation(theme, "dark");
      expect(theme.mode).toBe("system");
    },
  );

  it.each([
    {
      name: "hidden-only transient Light",
      initial: "dark",
      next: "light",
      resume: "dark",
      deliver: true,
    },
    {
      name: "real hidden Dark to Light change",
      initial: "dark",
      next: "light",
      resume: "light",
      deliver: false,
    },
    {
      name: "real hidden Light to Dark change",
      initial: "light",
      next: "dark",
      resume: "dark",
      deliver: false,
    },
  ] as const)(
    "admits only the foreground value after $name",
    ({ initial, next, resume, deliver }) => {
      const { browser, theme } = mountTheme(initial);
      expectPresentation(theme, initial);
      browser.setVisibility("hidden");
      browser.setRawMode(next);
      if (deliver) {
        browser.deliverChange();
      }
      expectPresentation(theme, initial);
      browser.setRawMode(resume);
      browser.setVisibility("visible");
      expectPresentation(theme, resume);
      expect(theme.mode).toBe("system");
    },
  );

  it.each(["light", "dark"] as const)("keeps explicit %s independent of resume inputs", (mode) => {
    const opposite = mode === "dark" ? "light" : "dark";
    const { browser, theme } = mountTheme(opposite);
    theme.setMode(mode);
    expectPresentation(theme, mode);
    browser.setRawMode(mode);
    browser.deliverChange();
    expectPresentation(theme, mode);
    browser.setVisibility("hidden");
    browser.setRawMode(opposite);
    browser.deliverChange();
    expectPresentation(theme, mode);
    browser.setVisibility("visible");
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expectPresentation(theme, mode);
    expect(theme.mode).toBe(mode);
  });

  it.each(["light", "dark"] as const)(
    "rereads current foreground %s when System is selected",
    (next) => {
      const previous = next === "dark" ? "light" : "dark";
      const { browser, theme } = mountTheme(previous, previous);
      browser.setRawMode(next);
      // Explicit mode has not subscribed to System changes.
      theme.setMode("system");
      expectPresentation(theme, next);
      expect(theme.mode).toBe("system");
      expect(loadSettings().themeMode).toBe("system");
    },
  );

  it.each(["local preference", "cross-tab storage", "server presentation"] as const)(
    "does not admit a hidden query through %s publication",
    (source) => {
      const { browser, theme } = mountTheme("dark");
      browser.setVisibility("hidden");
      browser.setRawMode("light");
      if (source === "server presentation") {
        theme.recordServerSelection("claw", "profile");
        expect(theme.serverSelection).toMatchObject({ theme: "claw", scope: "profile" });
      } else {
        if (source === "cross-tab storage") {
          const key = settingsKeyForGateway(theme.settings.gatewayUrl);
          localStorage.setItem(key, JSON.stringify({ ...theme.settings, textScale: 110 }));
          window.dispatchEvent(new StorageEvent("storage", { key }));
        } else {
          patchSettings({ textScale: 110 });
        }
        expect(theme.settings.textScale).toBe(110);
        expect(document.documentElement.style.getPropertyValue("--control-ui-text-scale")).toBe(
          "1.1",
        );
      }
      expectPresentation(theme, "dark");
      browser.setVisibility("visible");
      expectPresentation(theme, "light");
    },
  );

  it("uses the admitted mode when a pending palette finishes while hidden", () => {
    const { browser, theme } = mountTheme("dark");
    patchSettings({ theme: "knot" });
    const palette = document.getElementById("openclaw-theme-palette-knot");
    expect(palette).toBeInstanceOf(HTMLLinkElement);
    expectPresentation(theme, "dark");
    browser.setVisibility("hidden");
    browser.setRawMode("light");
    palette!.dispatchEvent(new Event("load"));
    expectPresentation(theme, "dark", { id: "knot", value: "openknot" });
  });

  it("reconciles a visible persisted pageshow and retires lifecycle listeners on dispose", () => {
    const { browser, theme } = mountTheme("dark");
    browser.setVisibility("hidden");
    browser.setRawMode("light");
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expectPresentation(theme, "dark");
    // Isolate bfcache restoration from the visibilitychange recovery path.
    browser.setVisibility("visible", false);
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expectPresentation(theme, "light");

    theme.dispose();
    browser.setRawMode("dark");
    browser.deliverChange();
    browser.setVisibility("hidden");
    browser.setVisibility("visible");
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expectPresentation(theme, "light");
  });
});
