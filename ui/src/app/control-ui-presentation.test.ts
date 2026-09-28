/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { controlUiAccentInk } from "./accent-contrast.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import { applyControlUiPresentation } from "./control-ui-environment-presentation.runtime.ts";
import { applyControlUiAccent, syncControlUiSystemChrome } from "./control-ui-presentation.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import { loadSettings, patchSettings, saveSettings } from "./settings.ts";

afterEach(() => {
  applyControlUiAccent();
  applyControlUiPresentation({ environment: null });
  document.documentElement.removeAttribute("style");
  document.body.replaceChildren();
});

describe("Control UI accent presentation", () => {
  it("keeps document chat layout and browser chrome in sync across route changes and removal", () => {
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
      syncControlUiSystemChrome();
      expect(root.classList.contains("control-ui-chat-shell")).toBe(true);
      expect(root.style.getPropertyValue("--control-ui-system-chrome-background")).toBe(
        "rgb(20, 30, 40)",
      );

      shell.className = "shell";
      syncControlUiSystemChrome();
      expect(root.classList.contains("control-ui-chat-shell")).toBe(false);
      expect(root.style.getPropertyValue("--control-ui-system-chrome-background")).toBe(
        "rgb(10, 20, 30)",
      );

      shell.className = "shell shell--chat";
      syncControlUiSystemChrome();
      shell.remove();
      syncControlUiSystemChrome();
      expect(root.classList.contains("control-ui-chat-shell")).toBe(false);
    } finally {
      root.classList.remove("control-ui-chat-shell");
      vi.unstubAllGlobals();
    }
  });

  it("prioritizes the user accent and restores operator and theme defaults in order", () => {
    const style = document.documentElement.style;
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

    applyControlUiAccent("theme");
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
  });

  it("keeps the locally restored user accent when operator bootstrap arrives afterward", () => {
    applyControlUiAccent("#6ee7b7");
    applyControlUiPresentation({ environment: null, seamColor: "#123456" });

    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#6ee7b7");
    expect(document.documentElement.style.getPropertyValue("--primary-foreground")).toBe("#000000");
  });

  it.each([
    ["#fbbf24", "#000000"],
    ["#6ee7b7", "#000000"],
    ["#777777", "#000000"],
    ["#747474", "#ffffff"],
    ["#2563eb", "#ffffff"],
  ])("selects readable ink for accent %s", (accent, expectedInk) => {
    expect(controlUiAccentInk(accent)).toBe(expectedInk);
    applyControlUiAccent(accent);

    expect(document.documentElement.style.getPropertyValue("--accent-foreground")).toBe(
      expectedInk,
    );
    expect(document.documentElement.style.getPropertyValue("--primary-foreground")).toBe(
      expectedInk,
    );
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

  it.each(["claw", "knot"] as const)(
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
