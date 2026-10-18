import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEFAULT_BACKGROUND_PREFERENCE,
  type BackgroundPreference,
} from "../../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { ApplicationContext, ApplicationTheme } from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import type { SessionBackground } from "../../components/session-background.tsx";
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
  vi.unstubAllGlobals();
});

async function mount(preference: Partial<BackgroundPreference> = {}) {
  const gateway = createApplicationGateway();
  const notifications = new EventTarget();
  const subscribe = (type: string) => (listener: () => void) => {
    notifications.addEventListener(type, listener);
    return () => notifications.removeEventListener(type, listener);
  };
  const notify = (type: string) => notifications.dispatchEvent(new Event(type));
  const settings = {
    ...loadSettings(),
    background: { ...DEFAULT_BACKGROUND_PREFERENCE, ...preference },
  };
  const theme: Pick<ApplicationTheme, "settings" | "resolvedMode" | "refresh" | "subscribe"> = {
    settings,
    resolvedMode: "dark",
    refresh: () => notify("theme"),
    subscribe: subscribe("theme"),
  };
  const context = {
    gateway: gateway.gateway,
    theme,
    router: { subscribe: subscribe("route") },
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
    navigate: () => notify("route"),
    dispose,
    setContext: (next: ApplicationContext) => {
      setCurrentContext(next);
      flush();
    },
  };
}

function press(range: HTMLInputElement, type = "pointerdown") {
  range.dispatchEvent(
    new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, bubbles: true }),
  );
}

function key(range: HTMLInputElement, value: string) {
  range.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
}

function activate(range: HTMLInputElement, gesture: "drag" | "Home" | "ArrowRight" = "ArrowRight") {
  if (gesture === "drag") {
    press(range);
  } else {
    key(range, gesture);
  }
  flush();
}

type Preview = Awaited<ReturnType<typeof mount>>;
const disabledPlacement = { showOnNewSession: false, showInSessions: false };
it("holds during a drag, settles 1.2 seconds after release, and keeps focused controls opaque", async () => {
  const preference = { ...disabledPlacement, presentation: "full-bleed" } as const;
  const { element, range, preview } = await mount(preference);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  range.focus();
  const before = range.getBoundingClientRect();
  activate(range, "drag");
  await preview.updateComplete;
  expect(preview).toMatchObject({
    surface: "preview",
    presented: true,
    preferenceOverride: preference,
  });
  expect(element.hasAttribute("data-background-preview")).toBe(true);
  expect(host.hasAttribute("data-background-preview")).toBe(true);
  expect(document.activeElement).toBe(range);
  expect(range.disabled).toBe(false);
  expect(range.getBoundingClientRect().toJSON()).toEqual(before.toJSON());
  expect(getComputedStyle(preview)).toMatchObject({
    pointerEvents: "none",
    position: "fixed",
    transitionDuration: "0s",
    animationName: "none",
  });
  const groupStyle = getComputedStyle(element.querySelector(".settings-group")!);
  expect(groupStyle.opacity).toBe("1");
  expect(groupStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  const canvas = host.getBoundingClientRect();
  expect(preview.getBoundingClientRect()).toMatchObject({
    top: canvas.top,
    left: canvas.left,
    width: host.clientWidth,
    height: host.clientHeight,
  });
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
  expect(element.style.getPropertyValue("--settings-background-preview-width")).toBe("");
  expect(document.activeElement).toBe(range);
});

it("shows keyboard changes without focus activation and resets the brief settle period", async () => {
  const { range, preview } = await mount();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  range.focus();
  expect(preview.presented).toBe(false);
  activate(range);
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

it.each(["drag", "same-turn keyboard"])("reopens after Escape from %s", async (gesture) => {
  const { range, preview } = await mount();
  activate(range, gesture === "drag" ? "drag" : "ArrowRight");
  key(range, "Escape");
  expect(preview.presented).toBe(false);
  if (gesture === "drag") {
    range.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(preview.presented).toBe(false);
    press(range, "pointerup");
  }
  key(range, "ArrowLeft");
  flush();
  expect(preview.presented).toBe(true);
});

it.each([
  ["blur", ({ range }) => range.blur()],
  ["window-blur", () => window.dispatchEvent(new Event("blur"))],
  ["pointercancel", ({ range }) => press(range, "pointercancel")],
  ["navigation", ({ navigate }) => navigate()],
  ["disconnect", ({ dispose }) => dispose()],
  [
    "profile replacement",
    ({ gateway }) =>
      gateway.publish({ ...gateway.gateway.snapshot, selfUser: { id: "next-profile" } }),
  ],
  ["context replacement", ({ context, setContext }) => setContext({ ...context })],
] satisfies Array<[string, (view: Preview) => void]>)(
  "retires the canvas on %s without leaving a delayed preview",
  async (reason, retire) => {
    const view = await mount();
    const { element, range, preview } = view;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    range.focus();
    activate(range, reason === "profile replacement" ? "drag" : "Home");
    expect(preview.presented).toBe(true);
    retire(view);
    expect(preview.presented).toBe(false);
    expect(element.hasAttribute("data-background-preview")).toBe(false);
    flush();
    expect(preview.presented).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(preview.presented).toBe(false);
  },
);

it("passes live preferences to the shared renderer without enabling disabled placement", async () => {
  const { range, preview, settings, theme } = await mount({ ...disabledPlacement, visibility: 0 });
  activate(range);
  await preview.updateComplete;
  expect(preview.preferenceOverride?.visibility).toBe(0);
  expect(preview.querySelector(".session-background__image")).toBeNull();
  settings.background = { ...settings.background, visibility: 0.8 };
  theme.refresh();
  flush();
  await preview.updateComplete;
  expect(preview.preferenceOverride).toMatchObject({ ...disabledPlacement, visibility: 0.8 });
  expect(range.getAttribute("aria-valuetext")).toBe("80%");
  expect(preview.querySelector(".session-background__image")).not.toBeNull();
  settings.background = { ...settings.background, source: { kind: "none" } };
  theme.refresh();
  flush();
  expect(preview.presented).toBe(false);
});
