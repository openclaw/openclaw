/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as themeColors from "../lib/theme-color.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import { initializeControlUiDocumentHead } from "./control-ui-document-head.ts";
import { applyControlUiPresentation } from "./control-ui-environment-presentation.runtime.ts";
import { applyControlUiAccent, syncControlUiSystemChrome } from "./control-ui-presentation.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import { loadSettings, patchSettings, saveSettings } from "./settings.ts";

afterEach(() => {
  applyControlUiAccent();
  applyControlUiPresentation({ environment: null });
  initializeControlUiDocumentHead();
  document.documentElement.removeAttribute("style");
  document.body.replaceChildren();
});

describe("Control UI accent presentation", () => {
  it("reuses palette colors across breakpoint changes", () => {
    const root = document.documentElement;
    // Shared jsdom workers can retain a previous file's theme attributes.
    root.dataset.theme = "claw";
    root.dataset.themeMode = "dark";
    const shell = document.body.appendChild(document.createElement("div"));
    const metas = ["light", "dark"].map((mode) => {
      const meta = document.createElement("meta");
      Object.assign(meta, { id: `openclaw-theme-color-${mode}`, name: "theme-color" });
      meta.media = `(prefers-color-scheme: ${mode})`;
      return meta;
    });
    const unrelatedMeta = document.createElement("meta");
    unrelatedMeta.name = "theme-color";
    unrelatedMeta.content = "#123456";
    document.head.append(...metas, unrelatedMeta);
    initializeControlUiDocumentHead();
    const palette = document.createElement("style");
    palette.textContent = ":root { --bg-content: #203040; }";
    document.head.append(palette);
    root.style.setProperty("--bg", "rgb(10, 20, 30)");
    let narrow = false;
    vi.stubGlobal("matchMedia", () => ({ matches: narrow }));
    const reads = vi.spyOn(globalThis, "getComputedStyle");
    const expectChrome = (color: string) => {
      for (const meta of metas) {
        expect(meta.content).toBe(color);
        expect(meta.hasAttribute("media")).toBe(false);
      }
      expect(unrelatedMeta.content).toBe("#123456");
      expect(root.style.getPropertyValue("--control-ui-system-chrome-background")).toBe(color);
    };
    try {
      shell.className = "shell shell--chat";
      syncControlUiSystemChrome(false, true);
      expectChrome("rgb(10, 20, 30)");
      reads.mockClear();
      for (let commit = 0; commit < 20; commit++) {
        shell.append(document.createElement("span"));
        syncControlUiSystemChrome();
      }
      expect(reads).not.toHaveBeenCalled();

      for (const property of [
        "--shell-viewport-height",
        "--shell-safe-area-bottom",
        ...["assistant", "terminal", "browser", "link-reader", "desktop"].flatMap((owner) => [
          `--oc-${owner}-reserve-bottom`,
          `--oc-${owner}-reserve-right`,
        ]),
      ]) {
        root.style.setProperty(property, "123px");
        syncControlUiSystemChrome();
      }
      expect(reads).not.toHaveBeenCalled();

      narrow = true;
      syncControlUiSystemChrome();
      expectChrome("#203040");
      expect(reads).not.toHaveBeenCalled();
      applyControlUiAccent("#123456");
      syncControlUiSystemChrome();
      expect(reads).toHaveBeenCalled();
      expectChrome("#203040");
      root.style.setProperty("--bg", "rgb(30, 40, 50)");
      syncControlUiSystemChrome();
      expectChrome("#203040");
      for (const [attribute, value] of [
        ["data-theme", "rose"],
        ["data-theme-mode", "light"],
      ] as const) {
        reads.mockClear();
        root.setAttribute(attribute, value);
        syncControlUiSystemChrome();
        expect(reads).toHaveBeenCalled();
        expectChrome("#203040");
      }
      // A custom palette can be replaced without changing root attributes.
      reads.mockClear();
      palette.textContent = ":root { --bg-content: #405060; }";
      syncControlUiSystemChrome(true);
      expect(reads).toHaveBeenCalled();
      expectChrome("#405060");
      reads.mockClear();
      syncControlUiSystemChrome();
      expect(reads).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      for (const meta of [...metas, unrelatedMeta]) {
        meta.remove();
      }
      palette.remove();
      root.classList.remove("control-ui-chat-shell");
      delete root.dataset.theme;
      delete root.dataset.themeMode;
      vi.unstubAllGlobals();
    }
  });

  it("uses the shell's committed chat layout across palette changes, routes, and removal", () => {
    const root = document.documentElement;
    const shell = document.body.appendChild(document.createElement("div"));
    root.style.setProperty("--bg", "rgb(10, 20, 30)");
    root.style.setProperty("--bg-content", "rgb(20, 30, 40)");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    try {
      shell.className = "shell shell--chat";
      syncControlUiSystemChrome(false, true);
      expect(root.classList.contains("control-ui-chat-shell")).toBe(true);
      expect(root.style.getPropertyValue("--control-ui-system-chrome-background")).toBe(
        "rgb(20, 30, 40)",
      );

      shell.className = "shell";
      syncControlUiSystemChrome();
      expect(root.classList.contains("control-ui-chat-shell")).toBe(true);
      syncControlUiSystemChrome(false, false);
      expect(root.classList.contains("control-ui-chat-shell")).toBe(false);
      expect(root.style.getPropertyValue("--control-ui-system-chrome-background")).toBe(
        "rgb(10, 20, 30)",
      );

      shell.className = "shell shell--chat";
      syncControlUiSystemChrome();
      expect(root.classList.contains("control-ui-chat-shell")).toBe(false);
      syncControlUiSystemChrome(false, true);
      shell.remove();
      syncControlUiSystemChrome(false, false);
      expect(root.classList.contains("control-ui-chat-shell")).toBe(false);
    } finally {
      root.classList.remove("control-ui-chat-shell");
      vi.unstubAllGlobals();
    }
  });

  it("prioritizes the user accent and restores operator and theme defaults in order", () => {
    const style = document.documentElement.style;
    const sampler = vi
      .spyOn(themeColors, "resolveThemeColors")
      .mockReturnValue([{ rgb: [1, 1, 1], alpha: 1 }]);
    style.setProperty("--bg", "#ffffff");
    style.setProperty("--bg-content", "#ffffff");
    try {
      applyControlUiPresentation({ environment: null, seamColor: "#123456" });
      expect(style.getPropertyValue("--accent")).toBe("#123456");
      expect(style.getPropertyValue("--primary-foreground")).toBe("#ffffff");

      applyControlUiAccent("#fbbf24");
      expect(style.getPropertyValue("--accent")).toBe("#fbbf24");
      expect(style.getPropertyValue("--primary")).toBe("#fbbf24");
      // Hover must ride the accent too; dark Claw/Knot primary buttons read it.
      expect(style.getPropertyValue("--primary-hover")).toBe(
        "color-mix(in srgb, var(--primary) 82%, white 18%)",
      );
      expect(style.getPropertyValue("--accent-foreground")).toBe("#000000");
      expect(style.getPropertyValue("--primary-foreground")).toBe("#000000");

      syncControlUiSystemChrome(true);
      const links = ["--link", "--link-on-tint"];
      const prepared = links.map((property) => style.getPropertyValue(property));
      expect(prepared.every(Boolean)).toBe(true);
      applyControlUiAccent("#fbbf24");
      syncControlUiSystemChrome(true);
      expect(links.map((property) => style.getPropertyValue(property))).toEqual(prepared);

      applyControlUiAccent("theme");
      syncControlUiSystemChrome(true);
      expect(links.map((property) => style.getPropertyValue(property))).toEqual(["", ""]);
      expect(style.getPropertyValue("--accent")).toBe("");
      expect(style.getPropertyValue("--primary-hover")).toBe("");
      applyControlUiPresentation({ environment: null, seamColor: "#abcdef" });
      expect(style.getPropertyValue("--accent")).toBe("");
      applyControlUiPresentation({ environment: null, seamColor: "#123456" });
      applyControlUiAccent();
      expect(style.getPropertyValue("--accent")).toBe("#123456");
      expect(style.getPropertyValue("--primary-foreground")).toBe("#ffffff");

      applyControlUiPresentation({ environment: null });
      for (const property of [
        "--accent",
        "--accent-foreground",
        "--primary-hover",
        "--primary-foreground",
      ]) {
        expect(style.getPropertyValue(property)).toBe("");
      }
    } finally {
      sampler.mockRestore();
    }
  });
});

describe("Live display preference presentation", () => {
  it("adopts navigation bindings without publishing or reapplying presentation", () => {
    const previous = loadSettings();
    saveSettings({ ...previous, theme: "claw", themeMode: "dark", chatShowThinking: true });
    const { gateway } = createGatewayStoreTestStore({ settings: loadSettings() });
    const theme = createApplicationTheme(loadSettings(), gateway);
    const notify = vi.fn();
    theme.subscribe(notify);
    const presentation = new MutationObserver(() => {});
    presentation.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    try {
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
      expect(document.documentElement.dataset.themeMode).toBe("light");
      expect(presentation.takeRecords().length).toBeGreaterThan(0);

      notify.mockClear();
      patchSettings({ sessionKey: "agent:main:mixed", chatShowThinking: false });
      expect(theme.settings).toMatchObject({
        sessionKey: "agent:main:mixed",
        chatShowThinking: false,
      });
      expect(notify).toHaveBeenCalledOnce();
    } finally {
      presentation.disconnect();
      theme.dispose();
      gateway.stop();
      saveSettings(previous);
    }
  });

  it.each(["knot"] as const)(
    "publishes preferences without waiting for the %s palette or render-time storage reads",
    (palette) => {
      const previous = loadSettings();
      const { gateway } = createGatewayStoreTestStore({ settings: previous });
      const theme = createApplicationTheme(previous, gateway);
      const notify = vi.fn();
      const unsubscribe = theme.subscribe(notify);
      try {
        patchSettings({
          theme: palette,
          chatSendShortcut: "modifier-enter",
          realtimeTalkInputDeviceId: "usb-mic",
        });
        expect(theme.settings).toMatchObject({
          chatSendShortcut: "modifier-enter",
          realtimeTalkInputDeviceId: "usb-mic",
        });
        expect(theme.settings).not.toHaveProperty("token");
        expect(notify).toHaveBeenCalled();
        const reads = vi.spyOn(Storage.prototype, "getItem");
        for (let i = 0; i < 20; i++) {
          expect(theme.settings.chatSendShortcut).toBe("modifier-enter");
        }
        expect(reads).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
        unsubscribe();
        theme.dispose();
        gateway.stop();
        saveSettings(previous);
      }
    },
  );
});
