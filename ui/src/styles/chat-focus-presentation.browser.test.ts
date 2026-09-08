import type { CDPSession } from "@vitest/browser-playwright";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cdp, userEvent } from "vitest/browser";
import { applyControlUiAccent } from "../app/control-ui-presentation.ts";
import baseStyles from "./base.css?inline";
import chatLayoutStyles from "./chat/layout.css?inline";
import messageStyles from "./chat/message-layout.css?inline";
import textStyles from "./chat/text.css?inline";
import toolStyles from "./chat/tool-cards.css?inline";
import componentStyles from "./components.css?inline";
import sidebarStyles from "./sidebar-markdown.css?inline";

const THEMES = [
  ["dark", "dark"],
  ["light", "light"],
  ["openknot", "dark"],
  ["openknot-light", "light"],
  ["dash", "dark"],
  ["dash-light", "light"],
] as const;

// Exercise the light-DOM CSS boundary, not media playback or disclosure state.
// Native element kinds and waveform nesting follow the production renderers.
const FIXTURE = `
  <button id="focus-start" type="button">Start</button>
  <div class="chat-audio-player" tabindex="0" data-focus-case="audio player">
    <button class="chat-audio-player__toggle" type="button" data-focus-case="play">Play</button>
    <div class="chat-audio-player__timeline">
      <input class="chat-audio-player__seek" type="range" aria-label="Seek" data-focus-case="seek">
    </div>
    <button class="chat-audio-player__volume" type="button" data-focus-case="mute">Mute</button>
  </div>
  <div class="chat-audio-player">
    <div class="chat-audio-player__timeline">
      <div class="chat-audio-player__waveform">
        <svg viewBox="0 0 100 24" aria-hidden="true"><rect x="1" y="2" width="98" height="20"></rect></svg>
        <input class="chat-audio-player__seek chat-audio-player__seek--waveform" type="range" aria-label="Waveform seek" data-focus-case="waveform">
      </div>
    </div>
  </div>
  <button class="chat-image-action" type="button" data-focus-case="image action">Open</button>
  <button class="chat-message-image-button" type="button" data-focus-case="message image">Image</button>
  <button class="chat-assistant-attachment-card__action" type="button" data-focus-case="attachment button">File</button>
  <a class="chat-assistant-attachment-card__action" href="#download" download data-focus-case="attachment link">Download</a>
  <div class="chat-text">
    <button class="markdown-inline-image-button" type="button" data-focus-case="chat inline image">Inline image</button>
    <div class="code-block-wrapper has-horizontal-overflow">
      <button class="code-block-expand" type="button" data-focus-case="expand code">Expand</button>
      <button class="code-block-wrap" type="button" data-focus-case="wrap code">Wrap</button>
    </div>
  </div>
  <button class="chat-inline-disclosure" type="button" aria-expanded="false" data-focus-case="disclosure">Tool details</button>
  <button class="chat-tool-card__preview-image-button" type="button" data-focus-case="tool image">Tool image</button>
  <div class="sidebar-markdown">
    <button class="markdown-inline-image-button" type="button" data-focus-case="sidebar inline image">Sidebar image</button>
  </div>
  <button class="chat-error__dismiss" type="button">Dismiss</button>
  <span id="ring-reference" style="color: var(--ring)"></span>
`;

describe("chat focus presentation", () => {
  let container: HTMLDivElement;
  let styles: HTMLStyleElement;
  let rootAttributes: Map<string, string | null>;
  let themeStyles: string[];

  beforeAll(async () => {
    // Public themes are served as assets, not transformed CSS modules.
    themeStyles = await Promise.all(
      ["/themes/knot.css", "/themes/dash.css"].map(async (url) => {
        const response = await fetch(url);
        expect(response.ok, url).toBe(true);
        return await response.text();
      }),
    );
  });

  beforeEach(() => {
    rootAttributes = new Map(
      ["data-theme", "data-theme-mode", "style"].map((name) => [
        name,
        document.documentElement.getAttribute(name),
      ]),
    );
    styles = document.createElement("style");
    // Match shared styles before the chat import order, including the sidebar sibling.
    styles.textContent = [
      baseStyles,
      componentStyles,
      chatLayoutStyles,
      messageStyles,
      textStyles,
      sidebarStyles,
      toolStyles,
      ...themeStyles,
    ].join("\n");
    document.head.append(styles);
    container = document.createElement("div");
    container.style.cssText = "width: 600px; padding: 32px;";
    container.innerHTML = FIXTURE;
    document.body.append(container);
  });

  afterEach(async () => {
    applyControlUiAccent();
    container.remove();
    styles.remove();
    for (const [name, value] of rootAttributes) {
      if (value === null) {
        document.documentElement.removeAttribute(name);
      } else {
        document.documentElement.setAttribute(name, value);
      }
    }
    const session: CDPSession = cdp();
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  });

  function setTheme(theme: string, mode: string) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themeMode = mode;
  }

  async function checkKeyboardOutlines(forcedColors = false) {
    const controls = container.querySelectorAll<HTMLElement>("[data-focus-case]");
    expect(controls.length).toBeGreaterThan(0);
    const ringColor = getComputedStyle(container.querySelector("#ring-reference")!).color;
    container.querySelector<HTMLButtonElement>("#focus-start")!.focus();
    for (const control of controls) {
      await userEvent.keyboard("{Tab}");
      const label = control.dataset.focusCase;
      expect(document.activeElement, label).toBe(control);
      expect(control.matches(":focus-visible"), label).toBe(true);
      // The transparent range remains keyboard-reachable; its parent paints the ring.
      const painted = control.classList.contains("chat-audio-player__seek--waveform")
        ? control.parentElement!
        : control;
      const style = getComputedStyle(painted);
      expect.soft(style.outlineStyle, label).toBe("solid");
      expect.soft(style.outlineWidth, label).toBe("2px");
      expect.soft(style.opacity, label).not.toBe("0");
      expect.soft(painted.getBoundingClientRect().width, label).toBeGreaterThan(0);
      expect.soft(style.outlineColor, label).not.toBe("rgba(0, 0, 0, 0)");
      if (!forcedColors) {
        expect.soft(style.outlineColor, label).toBe(ringColor);
      }
    }
    if (!forcedColors) {
      // A valid shadow-token consumer must stay intact; do not redefine --focus-ring as a color.
      await userEvent.keyboard("{Tab}");
      const shadowControl = container.querySelector(".chat-error__dismiss")!;
      expect(document.activeElement).toBe(shadowControl);
      expect(getComputedStyle(shadowControl).boxShadow).not.toBe("none");
    }
  }

  it.each(THEMES)("paints keyboard outlines in %s", async (theme, mode) => {
    setTheme(theme, mode);
    await checkKeyboardOutlines();
  });

  it.each(["dark", "light"])("inherits an operator accent in %s", async (mode) => {
    setTheme(mode, mode);
    applyControlUiAccent("#2878c8");
    await checkKeyboardOutlines();
  });

  it.each(["dark", "light"])(
    "retains outlines when forced colors suppress shadows in %s",
    async (mode) => {
      setTheme(mode, mode);
      await cdp().send("Emulation.setEmulatedMedia", {
        features: [
          { name: "forced-colors", value: "active" },
          { name: "prefers-color-scheme", value: mode },
        ],
      });
      expect(matchMedia("(forced-colors: active)").matches).toBe(true);
      await checkKeyboardOutlines(true);
    },
  );
});
