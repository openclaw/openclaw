import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BACKGROUND_PREFERENCE,
  type BackgroundPreference,
} from "../../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import type { ApplicationContext, ApplicationTheme } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import type { SessionBackground } from "../../components/session-background.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createApplicationGateway } from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { AppearanceBackground } from "./appearance-background.tsx";
import "../../styles.css";
import "../../styles/config.css";
import "../../styles/settings.css";

let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  host = document.createElement("div");
  host.className = "content";
  host.style.cssText = "position: fixed; inset: 24px 32px; overflow: auto;";
  document.body.append(host);
});
afterEach(() => {
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(preference: BackgroundPreference = DEFAULT_BACKGROUND_PREFERENCE) {
  const gateway = createApplicationGateway({
    client: null,
    phase: "stopped",
    offlineStable: false,
    hello: null,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  });
  const routeListeners = new Set<() => void>();
  const themeListeners = new Set<() => void>();
  const settings = { ...loadSettings(), background: { ...preference } };
  const theme: ApplicationTheme = {
    branding: resolveThemeBranding(undefined),
    settings,
    mode: "dark",
    resolvedMode: "dark",
    serverSelection: null,
    appliedPalette: null,
    recordServerSelection: () => undefined,
    setMode: () => undefined,
    refresh: () => themeListeners.forEach((listener) => listener()),
    subscribe: (listener) => {
      themeListeners.add(listener);
      return () => themeListeners.delete(listener);
    },
  };
  const context = {
    gateway: gateway.gateway,
    theme,
    router: {
      subscribe: (listener: () => void) => {
        routeListeners.add(listener);
        return () => routeListeners.delete(listener);
      },
    },
  } as ApplicationContext;
  const [currentContext, setCurrentContext] = createSignal(context);
  host.innerHTML = '<div class="config-content"><div class="settings-page"></div></div>';
  const container = host.querySelector<HTMLElement>(".settings-page")!;
  const { unmount: dispose } = mountSolid(
    () => <AppearanceBackground context={currentContext()} />,
    { container },
  );
  flush();
  const element = container.querySelector<HTMLElement>("openclaw-appearance-background")!;
  const range = element.querySelector<HTMLInputElement>('input[type="range"]')!;
  const preview = element.querySelector<SessionBackground>("[data-background-preview-canvas]")!;
  await preview.updateComplete;
  return {
    element,
    range,
    preview,
    gateway,
    settings,
    theme,
    context,
    routeListeners,
    dispose,
    setContext: (next: ApplicationContext) => {
      setCurrentContext(next);
      flush();
    },
  };
}

function press(range: HTMLInputElement, type = "pointerdown") {
  range.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      bubbles: true,
    }),
  );
}

function key(range: HTMLInputElement, value: string) {
  range.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
}

describe("Appearance background canvas peek", () => {
  it("holds during a drag, settles 1.2 seconds after release, and keeps focused controls opaque", async () => {
    const { element, range, preview } = await mount({
      ...DEFAULT_BACKGROUND_PREFERENCE,
      presentation: "full-bleed",
      showOnNewSession: false,
      showInSessions: false,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    range.focus();
    const before = range.getBoundingClientRect();
    press(range);
    flush();
    await preview.updateComplete;
    expect(preview.surface).toBe("preview");
    expect(preview.presented).toBe(true);
    expect(preview.preferenceOverride).toMatchObject({
      presentation: "full-bleed",
      showOnNewSession: false,
      showInSessions: false,
    });
    expect(element.hasAttribute("data-background-preview")).toBe(true);
    expect(host.hasAttribute("data-background-preview")).toBe(true);
    expect(document.activeElement).toBe(range);
    expect(range.disabled).toBe(false);
    expect(range.getBoundingClientRect().toJSON()).toEqual(before.toJSON());
    expect(getComputedStyle(preview).pointerEvents).toBe("none");
    expect(getComputedStyle(preview).position).toBe("fixed");
    expect(getComputedStyle(element.querySelector(".settings-group")!).opacity).toBe("1");
    expect(getComputedStyle(element.querySelector(".settings-group")!).backgroundColor).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    const canvas = host.getBoundingClientRect();
    expect(preview.getBoundingClientRect().left).toBe(canvas.left);
    expect(preview.getBoundingClientRect().width).toBe(host.clientWidth);
    await vi.advanceTimersByTimeAsync(2500);
    expect(preview.presented).toBe(true);
    press(range, "pointerup");
    await vi.advanceTimersByTimeAsync(1199);
    expect(preview.presented).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    flush();
    expect(preview.presented).toBe(false);
    expect(element.hasAttribute("data-background-preview")).toBe(false);
    expect(host.hasAttribute("data-background-preview")).toBe(false);
    expect(document.activeElement).toBe(range);
  });

  it("shows keyboard changes without focus activation and resets the brief settle period", async () => {
    const { range, preview } = await mount();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    range.focus();
    expect(preview.presented).toBe(false);
    key(range, "ArrowRight");
    flush();
    expect(preview.presented).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    key(range, "End");
    await vi.advanceTimersByTimeAsync(1000);
    expect(preview.presented).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    flush();
    expect(preview.presented).toBe(false);
    expect(document.activeElement).toBe(range);
  });

  it("cancels on Escape during dragging and does not reopen from the same gesture", async () => {
    const { range, preview } = await mount();
    press(range);
    flush();
    key(range, "Escape");
    expect(preview.presented).toBe(false);
    range.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(preview.presented).toBe(false);
    press(range, "pointerup");
    key(range, "ArrowLeft");
    flush();
    expect(preview.presented).toBe(true);
  });

  it("can reopen immediately after Escape before the next render", async () => {
    const { range, preview } = await mount();
    key(range, "ArrowRight");
    flush();
    key(range, "Escape");
    expect(preview.presented).toBe(false);
    key(range, "ArrowLeft");
    flush();
    expect(preview.presented).toBe(true);
  });

  it.each(["blur", "window-blur", "pointercancel", "navigation", "disconnect"] as const)(
    "retires the canvas on %s without leaving a delayed preview",
    async (reason) => {
      const { element, range, preview, routeListeners, dispose } = await mount();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      range.focus();
      key(range, "Home");
      flush();
      expect(preview.presented).toBe(true);
      switch (reason) {
        case "blur":
          range.blur();
          break;
        case "window-blur":
          window.dispatchEvent(new Event("blur"));
          break;
        case "pointercancel":
          press(range, "pointercancel");
          break;
        case "navigation":
          routeListeners.forEach((listener) => listener());
          break;
        case "disconnect":
          dispose();
          element.remove();
          break;
      }
      expect(preview.presented).toBe(false);
      expect(element.hasAttribute("data-background-preview")).toBe(false);
      await vi.advanceTimersByTimeAsync(1500);
      expect(preview.presented).toBe(false);
    },
  );

  it("retires on profile replacement even while the controls remain mounted", async () => {
    const { element, range, preview, gateway } = await mount();
    press(range);
    flush();
    gateway.publish({ ...gateway.gateway.snapshot, selfUser: { id: "next-profile" } });
    expect(preview.presented).toBe(false);
    expect(element.hasAttribute("data-background-preview")).toBe(false);
    flush();
    expect(preview.presented).toBe(false);
  });

  it("retires a preview when its application context is replaced", async () => {
    const { element, range, preview, context, setContext } = await mount();
    key(range, "ArrowRight");
    flush();
    expect(preview.presented).toBe(true);
    setContext({ ...context });
    flush();
    expect(preview.presented).toBe(false);
    expect(element.hasAttribute("data-background-preview")).toBe(false);
  });

  it("keeps the preview on the visible canvas when the settings page is scrolled", async () => {
    const { element, range, preview } = await mount();
    const spacer = document.createElement("div");
    spacer.style.height = "1200px";
    element.before(spacer);
    range.focus();
    range.scrollIntoView({ block: "center" });
    const scrollTop = host.scrollTop;
    expect(scrollTop).toBeGreaterThan(0);
    key(range, "ArrowRight");
    flush();
    await preview.updateComplete;
    expect(preview.getBoundingClientRect().top).toBe(host.getBoundingClientRect().top);
    expect(preview.getBoundingClientRect().height).toBe(host.clientHeight);
    expect(host.scrollTop).toBe(scrollTop);
    expect(getComputedStyle(preview).transitionDuration).toBe("0s");
    expect(getComputedStyle(preview).animationName).toBe("none");
  });

  it("retires on canvas resize without leaving preview geometry on the component", async () => {
    const { element, range, preview } = await mount();
    press(range);
    flush();
    window.dispatchEvent(new Event("resize"));
    expect(preview.presented).toBe(false);
    expect(element.style.getPropertyValue("--settings-background-preview-width")).toBe("");
    expect(element.hasAttribute("data-background-preview")).toBe(false);
  });

  it("passes live preferences to the shared renderer without enabling disabled placement", async () => {
    const { range, preview, settings, theme } = await mount({
      ...DEFAULT_BACKGROUND_PREFERENCE,
      visibility: 0,
      showOnNewSession: false,
      showInSessions: false,
    });
    key(range, "ArrowRight");
    flush();
    await preview.updateComplete;
    expect(preview.preferenceOverride?.visibility).toBe(0);
    expect(preview.querySelector(".session-background__image")).toBeNull();
    settings.background = { ...settings.background, visibility: 0.8 };
    theme.refresh();
    flush();
    await preview.updateComplete;
    expect(preview.preferenceOverride?.visibility).toBe(0.8);
    expect(range.getAttribute("aria-valuetext")).toBe("80%");
    expect(preview.querySelector(".session-background__image")).not.toBeNull();
    expect(preview.preferenceOverride?.showOnNewSession).toBe(false);
    expect(preview.preferenceOverride?.showInSessions).toBe(false);
    settings.background = { ...settings.background, source: { kind: "none" } };
    theme.refresh();
    flush();
    expect(preview.presented).toBe(false);
  });
});
