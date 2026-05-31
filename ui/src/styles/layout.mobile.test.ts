import { describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";

function readMobileCss(): string {
  return readStyleSheet("ui/src/styles/layout.mobile.css");
}

function readLayoutCss(): string {
  return readStyleSheet("ui/src/styles/layout.css");
}

function readGroupedChatCss(): string {
  return readStyleSheet("ui/src/styles/chat/grouped.css");
}

function selectorBlocks(css: string, selector: string): string[] {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`, "gs"))].map(
    (match) => match[0],
  );
}

describe("chat header responsive mobile styles", () => {
  it("keeps the chat header and session controls from clipping on narrow widths", () => {
    const css = readMobileCss();
    const layoutCss = readLayoutCss();

    expect(css).toContain("@media (max-width: 1320px)");
    expect(css).toContain(".content--chat .content-header");
    expect(layoutCss).toContain(".content--chat {\n  display: flex;\n  flex-direction: column;\n  gap: 2px;\n  overflow: hidden;\n  padding-top: 0;");
    expect(css).toContain("max-height: 44px;");
    expect(layoutCss).toContain(".content--chat .content-header .chat-controls__session-notice");
    expect(layoutCss).toContain("position: absolute;");
    expect(css).toContain(".chat-controls__session-row");
    expect(css).toContain('grid-template-areas: "agent session model";');
  });

  it("lays out mobile chat header action icons as an even full-width grid", () => {
    const css = readMobileCss();

    expect(css).toContain(
      ".chat-mobile-controls-wrapper .chat-controls-dropdown .chat-controls__thinking",
    );
    expect(css).toContain("grid-template-columns: repeat(4, minmax(0, 1fr));");
    expect(css).toContain(
      ".chat-mobile-controls-wrapper .chat-controls-dropdown .btn--icon {\n    width: 100%;",
    );
    expect(css).toContain("height: 44px;");
  });

  it("keeps chat session picker search icons from stretching in mobile controls", () => {
    const css = readMobileCss();

    expect(css).toContain(".chat-session-picker__icon-button.btn--icon {");
    expect(css).toContain("flex: 0 0 44px;");
    expect(css).toContain("width: 44px;");
    expect(css).toContain("min-width: 44px;");
  });

  it("restores single-page logs scrolling on mobile", () => {
    const mobileCss = readMobileCss();
    const logsBlock = selectorBlocks(mobileCss, ".content.content--logs").join("\n");
    const workspaceBlock = selectorBlocks(
      mobileCss,
      ".content.content--logs .settings-workspace",
    ).join("\n");
    const logStreamBlock = selectorBlocks(
      mobileCss,
      ".card--fill-height.card--fill-height .log-stream",
    ).join("\n");

    expect(logsBlock).toContain("display: block;");
    expect(logsBlock).toContain("overflow-y: auto;");
    expect(workspaceBlock).toContain("display: block;");
    expect(logStreamBlock).toContain("max-height: 380px;");
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

  it("keeps the sidebar new-session button inset and its icon visible", () => {
    const css = readLayoutCss();
    const sessionsBlock = selectorBlocks(css, ".sidebar-sessions").join("\n");
    const newSessionBlock = selectorBlocks(css, ".sidebar-new-session").join("\n");
    const newSessionIconBlock = selectorBlocks(css, ".sidebar-new-session__icon svg").join("\n");
    const collapsedSessionsBlock = selectorBlocks(
      css,
      ".sidebar--collapsed .sidebar-sessions",
    ).join("\n");

    expect(sessionsBlock).toContain("padding: 0 8px;");
    expect(newSessionBlock).toContain("min-height: 38px;");
    expect(newSessionBlock).toContain("box-sizing: border-box;");
    expect(newSessionIconBlock).toContain("stroke: currentColor;");
    expect(newSessionIconBlock).toContain("fill: none;");
    expect(collapsedSessionsBlock).toContain("padding: 0;");
  });
});

describe("topbar theme mode tooltip styles", () => {
  it("clamps the rightmost color mode tooltip inside the viewport edge", () => {
    const css = readLayoutCss();
    const lastChildAfterBlock = selectorBlocks(
      css,
      ".topbar-theme-mode__btn:last-child[data-tooltip]::after",
    ).join("\n");
    const lastChildHoverAfterBlock = selectorBlocks(
      css,
      ".topbar-theme-mode__btn:last-child[data-tooltip]:hover::after",
    ).join("\n");
    const lastChildFocusAfterBlock = selectorBlocks(
      css,
      ".topbar-theme-mode__btn:last-child[data-tooltip]:focus-visible::after",
    ).join("\n");

    expect(lastChildAfterBlock).toContain("right: 0;");
    expect(lastChildHoverAfterBlock).toContain("transform: translateY(0);");
    expect(lastChildFocusAfterBlock).toContain("transform: translateY(0);");
    const tooltipBlock =
      selectorBlocks(css, ".topbar-theme-mode__btn[data-tooltip]::after").find((block) =>
        block.includes("content: attr(data-tooltip);"),
      ) ?? "";
    expect(tooltipBlock).toBeTruthy();
    expect(tooltipBlock).not.toContain("min-width:");
    expect(tooltipBlock).toContain("max-width: min(220px, 60vw);");
  });
});

describe("grouped chat width styles", () => {
  it("uses the config-fed CSS variable with the current fallback", () => {
    const css = readGroupedChatCss();

    expect(css).toContain("max-width: var(--chat-message-max-width, min(900px, 68%));");
  });

  it("excludes tool shells from light hover without overriding user bubble hover", () => {
    const css = readGroupedChatCss();

    expect(css).toContain(
      ':root[data-theme-mode="light"] .chat-bubble:not(:where(.chat-bubble--tool-shell)):hover',
    );
    expect(css).not.toContain(
      ':root[data-theme-mode="light"] .chat-bubble:not(.chat-bubble--tool-shell):hover',
    );
  });
});
