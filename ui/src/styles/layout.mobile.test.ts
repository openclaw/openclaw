import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readMobileCss(): string {
  const cssPath = [
    resolve(process.cwd(), "ui/src/styles/layout.mobile.css"),
    resolve(process.cwd(), "..", "ui/src/styles/layout.mobile.css"),
  ].find((candidate) => existsSync(candidate));
  expect(cssPath).toBeTruthy();
  return readFileSync(cssPath!, "utf8");
}

function readLayoutCss(): string {
  const cssPath = [
    resolve(process.cwd(), "ui/src/styles/layout.css"),
    resolve(process.cwd(), "..", "ui/src/styles/layout.css"),
  ].find((candidate) => existsSync(candidate));
  expect(cssPath).toBeTruthy();
  return readFileSync(cssPath!, "utf8");
}

function readGroupedChatCss(): string {
  const cssPath = [
    resolve(process.cwd(), "ui/src/styles/chat/grouped.css"),
    resolve(process.cwd(), "..", "ui/src/styles/chat/grouped.css"),
  ].find((candidate) => existsSync(candidate));
  expect(cssPath).toBeTruthy();
  return readFileSync(cssPath!, "utf8");
}

describe("chat header responsive mobile styles", () => {
  it("keeps the chat header and session controls from clipping on narrow widths", () => {
    const css = readMobileCss();

    expect(css).toContain("@media (max-width: 1320px)");
    expect(css).toContain(".content--chat .content-header");
    expect(css).toContain(".chat-controls__session-row");
    expect(css).toContain(".chat-controls__thinking-select");
  });
});

describe("sidebar menu trigger styles", () => {
  it("keeps the mobile sidebar trigger visibly interactive on hover and keyboard focus", () => {
    const css = readLayoutCss();

    expect(css).toContain(".sidebar-menu-trigger {");
    expect(css).toContain("cursor: pointer;");
    expect(css).toContain(".sidebar-menu-trigger:hover {");
    expect(css).toContain("background: color-mix(in srgb, var(--bg-hover) 84%, transparent);");
    expect(css).toContain("color: var(--text);");
    expect(css).toContain(".sidebar-menu-trigger:focus-visible {");
    expect(css).toContain("box-shadow: var(--focus-ring);");
    expect(css).toContain(".topbar-nav-toggle {");
    expect(css).toContain("display: none;");
  });
});

describe("grouped chat width styles", () => {
  it("uses the config-fed CSS variable with the current fallback", () => {
    const css = readGroupedChatCss();

    expect(css).toContain("max-width: var(--chat-message-max-width, min(900px, 68%));");
  });

  it("keeps touch actions out of assistant text flow", () => {
    const css = readGroupedChatCss();

    expect(css).toContain(".chat-bubble--has-actions");
    expect(css).toContain("@media (hover: none)");
    expect(css).toContain("flex-direction: column;");
    expect(css).toContain("position: static;");
    expect(css).toContain("order: 2;");
    expect(css).toContain("margin-top: 8px;");
    expect(css).toContain("min-width: 44px;");
    expect(css).toContain("min-height: 44px;");
  });

  it("keeps mobile message footers from crowding metadata actions", () => {
    const css = readGroupedChatCss();

    expect(css).toContain(".chat-group-footer");
    expect(css).toContain("max-width: 42vw;");
    expect(css).toContain("text-overflow: ellipsis;");
    expect(css).toContain("min-height: 36px;");
    expect(css).toContain(".msg-meta__summary");
    expect(css).toContain("min-height: 34px;");
  });
});

describe("mobile chat target sizing", () => {
  it("keeps mobile topbar controls at phone-sized hit targets", () => {
    const css = readMobileCss();

    expect(css).toContain(".topbar .sidebar-menu-trigger");
    expect(css).toContain(".topbar-search");
    expect(css).toContain(".chat-controls-mobile-toggle");
    expect(css).toContain("width: 44px;");
    expect(css).toContain("height: 44px;");
  });
});

describe("mobile chat controls sheet", () => {
  it("uses a fixed safe-area panel with a backdrop instead of a narrow topbar popover", () => {
    const css = readMobileCss();

    expect(css).toContain(".chat-mobile-controls-wrapper .chat-controls-sheet-backdrop");
    expect(css).toContain("position: fixed;");
    expect(css).toContain("inset: 0;");
    expect(css).toContain(".chat-mobile-controls-wrapper .chat-controls-dropdown");
    expect(css).toContain(
      "top: calc(var(--safe-area-top, 0px) + var(--shell-topbar-height) + 12px);",
    );
    expect(css).toContain("max-height: min(58svh, 420px);");
    expect(css).toContain("overflow-y: auto;");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr));");
    expect(css).toContain(".chat-controls__mobile-label");
    expect(css).toContain("text-overflow: ellipsis;");
  });

  it("uses a two-column controls layout only for wider short landscape phones", () => {
    const css = readMobileCss();

    expect(css).toContain(
      "@media (max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
    );
    expect(css).toContain("@media (min-width: 640px)");
    expect(css).toContain("grid-template-columns: minmax(240px, 1fr) minmax(300px, 1.3fr);");
    expect(css).toContain("grid-row: 1 / span 2;");
    expect(css).toContain(
      "max-height: calc(100svh - var(--safe-area-top, 0px) - var(--shell-topbar-height) - 20px);",
    );
  });
});

describe("mobile composer safe area", () => {
  it("keeps the composer clear of phone browser and device bottom insets", () => {
    const css = readMobileCss();

    expect(css).toContain(".agent-chat__input");
    expect(css).toContain("max(10px, calc(10px + env(safe-area-inset-bottom)))");
  });
});

describe("mobile sidebar rail", () => {
  it("hides the collapsed nav rail on phone widths until the drawer is opened", () => {
    const css = readMobileCss();

    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain(
      "(max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
    );
    expect(css).toContain(".shell--nav-collapsed:not(.shell--nav-drawer-open) .shell-nav");
    expect(css).toContain("transform: translateX(-100%);");
    expect(css).toContain("opacity: 0;");
    expect(css).toContain("pointer-events: none;");
  });
});
