import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("settings-rhythm-", { ignoreCloseErrors: true });

const css = readStyles(
  "styles/base",
  "styles/layout",
  "components/solid/icon-button",
  "styles/components",
  "styles/settings-controls",
  "styles/settings",
  "styles/agents",
  "styles/agent-emoji-picker",
);

// Mirrors settings-sidebar.tsx, agents/view.tsx and panels-overview.tsx markup.
const markup = `<div class="shell shell--settings">
  <aside class="settings-sidebar" style="width: 309px">
    <header class="settings-sidebar__header">
      <button type="button" class="settings-sidebar__back">
        <span class="settings-sidebar__back-icon"><svg viewBox="0 0 24 24"></svg></span>Back to app
      </button>
      <h1 class="settings-sidebar__title">Settings</h1>
    </header>
    <div class="settings-sidebar__agent">
      <openclaw-agent-select class="agent-select">
        <button type="button" class="agent-select__trigger">
          <span class="agent-select__avatar"></span><span class="agent-select__label">Molty</span>
        </button>
      </openclaw-agent-select>
    </div>
    <div class="settings-sidebar__search" role="search">
      <span class="settings-sidebar__search-icon"><svg viewBox="0 0 24 24"></svg></span>
      <input class="settings-sidebar__search-input" type="search" placeholder="Search settings" />
    </div>
    <nav class="settings-sidebar__nav">
      <div class="settings-sidebar__group">
        <div class="settings-sidebar__group-label">Connections</div>
        <a class="settings-sidebar__item" href="#/settings/channels">
          <span class="settings-sidebar__item-icon"><svg viewBox="0 0 24 24"></svg></span>
          <span class="settings-sidebar__item-label">Channels</span>
        </a>
      </div>
    </nav>
  </aside>
  <main class="content">
    <section class="content-header content-header--settings">
      <h1 class="page-title">Agents</h1>
      <div class="agents-toolbar-actions">
        <button type="button" class="oc-icon-button oc-icon-button--32 refresh-button" aria-label="Refresh"><svg viewBox="0 0 24 24"></svg></button>
        <button type="button" class="btn btn--sm agents-create-btn">New agent</button>
        <button type="button" class="oc-menu-trigger btn btn--sm agents-page-menu__trigger" aria-label="More actions"><svg viewBox="0 0 24 24"></svg></button>
      </div>
    </section>
    <div class="agent-identity-editor__fields">
      <label class="field"><span>Emoji</span>
        <div class="agent-identity-editor__emoji-control">
          <input type="text" value="🦞" />
          <openclaw-agent-emoji-picker>
            <button type="button" class="agent-emoji-picker__trigger" aria-label="Pick emoji"><svg viewBox="0 0 24 24"></svg></button>
          </openclaw-agent-emoji-picker>
        </div>
      </label>
    </div>
  </main>
</div>`;

type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: string;
  textStart: number;
};

function readGeometry(page: import("playwright").Page) {
  return page.evaluate(() => {
    const box = (selector: string): Box => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        radius: style.borderTopLeftRadius,
        textStart:
          rect.x + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft),
      };
    };
    return {
      back: box(".settings-sidebar__back"),
      backIcon: box(".settings-sidebar__back-icon"),
      title: box(".settings-sidebar__title"),
      agentTrigger: box(".settings-sidebar__agent .agent-select__trigger"),
      avatar: box(".settings-sidebar__agent .agent-select__avatar"),
      searchInput: box(".settings-sidebar__search-input"),
      searchIcon: box(".settings-sidebar__search-icon"),
      groupLabel: box(".settings-sidebar__group-label"),
      item: box(".settings-sidebar__item"),
      itemIcon: box(".settings-sidebar__item-icon"),
      itemLabel: box(".settings-sidebar__item-label"),
      refresh: box(".agents-toolbar-actions .refresh-button"),
      create: box(".agents-create-btn"),
      menu: box(".agents-page-menu__trigger"),
      emojiInput: box(".agent-identity-editor__emoji-control > input"),
      emojiTrigger: box(".agent-emoji-picker__trigger"),
    };
  });
}

fixture.describe("Settings rhythm", () => {
  it("keeps one control height, radius and left inset through the sidebar header stack", async () => {
    const g = await fixture.withPage(
      "sidebar",
      styleDocument(css, markup, 'data-theme-mode="dark"'),
      readGeometry,
    );
    const stack = [g.back, g.agentTrigger, g.searchInput, g.item];
    expect(stack.map((control) => control.height)).toEqual([32, 32, 32, 32]);
    expect(new Set(stack.map((control) => control.radius)).size).toBe(1);
    // Glyphs and text start on the nav rows' edge: 12px panel inset + 1px border + 9px padding.
    const edge = g.itemIcon.x;
    expect(edge).toBe(22);
    expect([
      g.backIcon.x,
      g.title.textStart,
      g.avatar.x,
      g.searchIcon.x,
      g.groupLabel.textStart,
    ]).toEqual([edge, edge, edge, edge, edge]);
    // Typed search text lines up with the nav labels.
    expect(g.searchInput.textStart).toBe(g.itemLabel.x);
  });

  it("gives the Agents toolbar one control height and radius", async () => {
    const g = await fixture.withPage(
      "toolbar",
      styleDocument(css, markup, 'data-theme-mode="dark"'),
      readGeometry,
    );
    const row = [g.refresh, g.create, g.menu];
    expect(row.map((control) => control.height)).toEqual([32, 32, 32]);
    expect(row.map((control) => control.width)).toEqual([32, g.create.width, 32]);
    expect(new Set(row.map((control) => control.radius)).size).toBe(1);
    expect(g.refresh.radius).toBe(g.searchInput.radius);
  });

  it("nests the emoji picker trigger concentrically inside its field", async () => {
    const g = await fixture.withPage(
      "emoji",
      styleDocument(css, markup, 'data-theme-mode="dark"'),
      readGeometry,
    );
    const inset = 3;
    expect(g.emojiTrigger.height).toBe(g.emojiInput.height - inset * 2);
    expect(g.emojiTrigger.y).toBeCloseTo(g.emojiInput.y + inset, 1);
    expect(
      g.emojiInput.x + g.emojiInput.width - (g.emojiTrigger.x + g.emojiTrigger.width),
    ).toBeCloseTo(inset, 1);
    expect(Number.parseFloat(g.emojiTrigger.radius)).toBe(
      Number.parseFloat(g.emojiInput.radius) - inset,
    );
  });
});
