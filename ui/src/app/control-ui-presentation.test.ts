/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import { bindControlUiDocumentHead } from "./control-ui-document-head.ts";
import { applyControlUiPresentation } from "./control-ui-environment-presentation.runtime.ts";
import { applyControlUiAccent, syncControlUiSystemChrome } from "./control-ui-presentation.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import { loadSettings, patchSettings, saveSettings } from "./settings.ts";

const root = document.documentElement;
const css = (property: string) => root.style.getPropertyValue(property);
const cleanups: Array<() => void> = [];
function chromeFixture(content: string) {
  const shell = document.body.appendChild(document.createElement("div"));
  const metas = ["light", "dark"].map((mode) => {
    const meta = document.createElement("meta");
    Object.assign(meta, { name: "theme-color", media: `(prefers-color-scheme: ${mode})` });
    return meta;
  });
  const unrelatedMeta = document.createElement("meta");
  Object.assign(unrelatedMeta, { name: "theme-color", content: "#123456" });
  document.head.append(...metas, unrelatedMeta);
  bindControlUiDocumentHead({ themeColors: metas, favicons: [] });
  const palette = document.head.appendChild(document.createElement("style"));
  palette.textContent = `:root { --bg-content: ${content}; }`;
  root.style.setProperty("--bg", "rgb(10, 20, 30)");
  Object.assign(root.dataset, { theme: "claw", themeMode: "dark" });
  const viewport = { matches: false };
  vi.stubGlobal("matchMedia", () => viewport);
  const reads = vi.spyOn(globalThis, "getComputedStyle");
  cleanups.push(...[palette, ...metas, unrelatedMeta].map((element) => () => element.remove()));
  return {
    shell,
    palette,
    reads,
    viewport,
    check(color: string, force = false) {
      syncControlUiSystemChrome(force);
      for (const meta of metas) {
        expect(meta.content).toBe(color);
        expect(meta.hasAttribute("media")).toBe(false);
      }
      expect(unrelatedMeta.content).toBe("#123456");
      expect(css("--control-ui-system-chrome-background")).toBe(color);
      return expect(reads);
    },
  };
}
function displayTheme(patch: Partial<ReturnType<typeof loadSettings>> = {}) {
  const previous = loadSettings();
  saveSettings({ ...previous, ...patch });
  const { gateway } = createGatewayStoreTestStore({ settings: loadSettings() });
  const theme = createApplicationTheme(loadSettings(), gateway);
  const notify = vi.fn();
  theme.subscribe(notify);
  cleanups.push(() => {
    theme.dispose();
    gateway.stop();
    saveSettings(previous);
  });
  return { theme, notify };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  root.classList.remove("control-ui-chat-shell");
  delete root.dataset.theme;
  delete root.dataset.themeMode;
  applyControlUiAccent();
  applyControlUiPresentation({ environment: null });
  bindControlUiDocumentHead({ themeColors: [], favicons: [] });
  root.removeAttribute("style");
  document.body.replaceChildren();
});

it("samples chrome only when palette, inline presentation, or breakpoint changes", () => {
  const { shell, palette, reads, viewport, check } = chromeFixture("#203040");
  shell.className = "shell shell--chat";
  check("rgb(10, 20, 30)");
  reads.mockClear();
  for (let commit = 0; commit < 20; commit++) {
    shell.append(document.createElement("span"));
    syncControlUiSystemChrome();
  }
  expect(reads).not.toHaveBeenCalled();
  viewport.matches = true;
  check("#203040");
  applyControlUiAccent("#123456");
  check("#203040").toHaveBeenCalledTimes(2);
  root.style.setProperty("--bg", "rgb(30, 40, 50)");
  check("#203040");
  for (const [attribute, value] of [
    ["data-theme", "rose"],
    ["data-theme-mode", "light"],
  ] as const) {
    reads.mockClear();
    root.setAttribute(attribute, value);
    check("#203040").toHaveBeenCalledOnce();
  }
  palette.textContent = ":root { --bg-content: #405060; }";
  check("#405060", true).toHaveBeenCalledTimes(2);
  syncControlUiSystemChrome();
  expect(reads).toHaveBeenCalledTimes(2);
});

it("syncs chat layout and browser chrome across route changes and removal", () => {
  const { shell, viewport, check } = chromeFixture("rgb(20, 30, 40)");
  viewport.matches = true;
  for (const [className, active, color] of [
    ["shell shell--chat", true, "rgb(20, 30, 40)"],
    ["shell", false, "rgb(10, 20, 30)"],
  ] as const) {
    shell.className = className;
    check(color);
    expect(root.classList.contains("control-ui-chat-shell")).toBe(active);
  }
  shell.className = "shell shell--chat";
  syncControlUiSystemChrome();
  shell.remove();
  syncControlUiSystemChrome();
  expect(root.classList.contains("control-ui-chat-shell")).toBe(false);
});

it("prioritizes user accent, then restores operator and theme defaults", () => {
  applyControlUiPresentation({ environment: null, seamColor: "#123456" });
  expect([css("--accent"), css("--primary-foreground")]).toEqual(["#123456", "#ffffff"]);
  applyControlUiAccent("#fbbf24");
  expect(["--accent", "--primary", "--accent-foreground", "--primary-foreground"].map(css)).toEqual(
    ["#fbbf24", "#fbbf24", "#000000", "#000000"],
  );
  expect(css("--primary-hover")).toBe("color-mix(in srgb, var(--primary) 82%, white 18%)");
  applyControlUiAccent("theme");
  expect([css("--accent"), css("--primary-hover")]).toEqual(["", ""]);
  applyControlUiPresentation({ environment: null, seamColor: "#abcdef" });
  expect(css("--accent")).toBe("");
  applyControlUiPresentation({ environment: null, seamColor: "#123456" });
  applyControlUiAccent();
  expect([css("--accent"), css("--primary-foreground")]).toEqual(["#123456", "#ffffff"]);
  applyControlUiPresentation({ environment: null });
  expect(
    ["--accent", "--accent-foreground", "--primary-hover", "--primary-foreground"].map(css),
  ).toEqual(["", "", "", ""]);
});

it("adopts navigation without publishing or reapplying presentation", () => {
  const { theme, notify } = displayTheme({
    theme: "claw",
    themeMode: "dark",
    chatShowThinking: true,
  });
  const presentation = new MutationObserver(() => {});
  cleanups.push(() => presentation.disconnect());
  presentation.observe(root, { attributes: true, childList: true, subtree: true });
  for (const patch of [
    { sessionKey: "agent:research:review" },
    { lastActiveSessionKey: "agent:research:review" },
    { selectedAgentId: "research" },
    { sessionKey: "agent:main:next", lastActiveSessionKey: "agent:main:next" },
  ]) {
    patchSettings(patch);
    expect(theme.settings).toMatchObject(patch);
    expect.soft(notify).not.toHaveBeenCalled();
    expect.soft(presentation.takeRecords()).toEqual([]);
  }
  patchSettings({ themeMode: "light" });
  expect(notify).toHaveBeenCalledOnce();
  expect(root.dataset.themeMode).toBe("light");
  expect(presentation.takeRecords().length).toBeGreaterThan(0);
  notify.mockClear();
  patchSettings({ sessionKey: "agent:main:mixed", chatShowThinking: false });
  expect(theme.settings).toMatchObject({ sessionKey: "agent:main:mixed", chatShowThinking: false });
  expect(notify).toHaveBeenCalledOnce();
});

it("publishes preferences without waiting for the knot palette or storage reads", () => {
  const { theme, notify } = displayTheme();
  const preferences = {
    chatSendShortcut: "modifier-enter",
    realtimeTalkInputDeviceId: "usb-mic",
  } as const;
  patchSettings({ theme: "knot", ...preferences });
  expect(theme.settings).toMatchObject(preferences);
  expect(theme.settings).not.toHaveProperty("token");
  expect(notify).toHaveBeenCalled();
  const reads = vi.spyOn(Storage.prototype, "getItem");
  for (let i = 0; i < 20; i++) {
    expect(theme.settings.chatSendShortcut).toBe("modifier-enter");
  }
  expect(reads).not.toHaveBeenCalled();
});
