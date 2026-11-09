import type { Page } from "playwright";
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

const svg = '<svg viewBox="0 0 24 24"></svg>';
// Mirrors settings-sidebar.tsx, agents/view.tsx and panels-overview.tsx markup.
const markup = `<div class="shell shell--settings">
  <aside class="settings-sidebar" style="width: 309px">
    <header class="settings-sidebar__header">
      <button type="button" class="settings-sidebar__back"><span class="settings-sidebar__back-icon">${svg}</span>Back to app</button>
      <h1 class="settings-sidebar__title">Settings</h1>
    </header>
    <div class="settings-sidebar__agent"><openclaw-agent-select class="agent-select">
      <button type="button" class="agent-select__trigger"><span class="agent-select__avatar"></span><span class="agent-select__label">Molty</span></button>
    </openclaw-agent-select></div>
    <div class="settings-sidebar__search" role="search">
      <span class="settings-sidebar__search-icon">${svg}</span>
      <input class="settings-sidebar__search-input" type="search" placeholder="Search settings" />
    </div>
    <nav class="settings-sidebar__nav"><div class="settings-sidebar__group">
      <div class="settings-sidebar__group-label">Connections</div>
      <a class="settings-sidebar__item" href="#/settings/channels"><span class="settings-sidebar__item-icon">${svg}</span><span class="settings-sidebar__item-label">Channels</span></a>
    </div></nav>
  </aside>
  <main class="content">
    <section class="content-header content-header--settings"><h1 class="page-title">Agents</h1>
      <div class="agents-toolbar-actions">
        <button type="button" class="oc-icon-button oc-icon-button--32 refresh-button" aria-label="Refresh">${svg}</button>
        <button type="button" class="btn btn--sm agents-create-btn">New agent</button>
        <button type="button" class="oc-menu-trigger btn btn--sm agents-page-menu__trigger" aria-label="More actions">${svg}</button>
      </div>
    </section>
    <div class="agent-identity-editor__fields"><label class="field"><span>Emoji</span>
      <div class="agent-identity-editor__emoji-control"><input type="text" value="🦞" />
        <openclaw-agent-emoji-picker><button type="button" class="agent-emoji-picker__trigger" aria-label="Pick emoji">${svg}</button></openclaw-agent-emoji-picker>
      </div>
    </label></div>
  </main>
</div>`;

const SELECTORS = {
  back: ".settings-sidebar__back",
  backIcon: ".settings-sidebar__back-icon",
  title: ".settings-sidebar__title",
  agentTrigger: ".settings-sidebar__agent .agent-select__trigger",
  avatar: ".settings-sidebar__agent .agent-select__avatar",
  searchInput: ".settings-sidebar__search-input",
  searchIcon: ".settings-sidebar__search-icon",
  groupLabel: ".settings-sidebar__group-label",
  item: ".settings-sidebar__item",
  itemIcon: ".settings-sidebar__item-icon",
  itemLabel: ".settings-sidebar__item-label",
  refresh: ".agents-toolbar-actions .refresh-button",
  create: ".agents-create-btn",
  menu: ".agents-page-menu__trigger",
  emojiInput: ".agent-identity-editor__emoji-control > input",
  emojiTrigger: ".agent-emoji-picker__trigger",
};
type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: string;
  textStart: number;
};

function readGeometry(page: Page) {
  return page.evaluate((selectors) => {
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
    return Object.fromEntries(
      Object.entries(selectors).map(([name, selector]) => [name, box(selector)]),
    ) as Record<keyof typeof selectors, Box>;
  }, SELECTORS);
}

const document = styleDocument(css, markup, 'data-theme-mode="dark"');

fixture.describe("Settings rhythm", () => {
  it("keeps one control height, radius and left inset through the sidebar header stack", async () => {
    const g = await fixture.withPage("sidebar", document, readGeometry);
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
    ]).toEqual(Array(5).fill(edge));
    // Typed search text lines up with the nav labels.
    expect(g.searchInput.textStart).toBe(g.itemLabel.x);
  });

  it("gives the Agents toolbar one control height and radius, and nests the emoji trigger concentrically", async () => {
    const g = await fixture.withPage("toolbar", document, readGeometry);
    const row = [g.refresh, g.create, g.menu];
    expect(row.map((control) => control.height)).toEqual([32, 32, 32]);
    expect(row.map((control) => control.width)).toEqual([32, g.create.width, 32]);
    expect(new Set(row.map((control) => control.radius)).size).toBe(1);
    expect(g.refresh.radius).toBe(g.searchInput.radius);
    // The trigger sits 3px inside the 32px field, so its box and radius are the field's minus that inset.
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

  it("keeps the Agents menu trigger on the shared 38px phone control height", async () => {
    const page = await fixture.page({ viewport: { width: 390, height: 844 } });
    try {
      await page.setContent(document);
      const g = await readGeometry(page);
      expect([g.menu.width, g.menu.height, g.create.height]).toEqual([38, 38, 38]);
    } finally {
      await page.close();
    }
  });
});
