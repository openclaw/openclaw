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

  it("reserves room for the mobile keyboard when the chat composer is focused", () => {
    const css = readMobileCss();

    expect(css).toContain("var(--mobile-keyboard-inset, 0px)");
    expect(css).toContain("--chat-thread-bottom-padding");
    expect(css).toContain(".content--chat .agent-chat__input");
    expect(css).toContain(".content--chat .agent-chat__input:focus-within");
    expect(css).toContain("-webkit-backdrop-filter: none;");
    expect(css).toContain("position: fixed;");
    expect(css).toContain(".chat-send-btn");
    expect(css).toContain("min-width: 44px;");
    expect(css).toContain(
      "bottom: calc(max(10px, var(--safe-area-bottom)) + var(--mobile-keyboard-inset, 0px));",
    );
    expect(css).toContain("padding: 8px;");
    expect(css).toContain(".agent-chat__mobile-actions");
    expect(css).toContain(".agent-chat__desktop-run-control");
    expect(css).toContain("grid-template-areas:");
    expect(css).toContain('"left composer right"');
    expect(css).toContain("display: contents;");
    expect(css).not.toContain("46dvh");
    expect(css).toContain("top: var(--safe-area-top);");
    expect(css).toContain("bottom: var(--safe-area-bottom);");
    expect(css).toContain(".shell--nav-drawer-open .content--chat .agent-chat__input");
    expect(css).toContain("visibility: hidden;");
    expect(css).toContain("pointer-events: none;");
    expect(css).toContain("z-index: 40;");
    expect(css).toContain("display: none !important;");
    expect(css).toContain("z-index: -1 !important;");
    expect(css).not.toContain(".agent-chat__input:focus-within .agent-chat__toolbar-right");
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

  it("keeps OpenClaw chat avatars compact beside the conversation", () => {
    const css = readGroupedChatCss();

    expect(css).toContain(
      ".chat-avatar {\n  width: 108px !important;\n  height: 108px !important;",
    );
    expect(css).toContain("max-width: min(980px, calc(100% - 118px));");
    expect(css).toContain("max-width: calc(100% - 82px);");
    expect(css).toContain("width: 72px !important;");
  });
});
