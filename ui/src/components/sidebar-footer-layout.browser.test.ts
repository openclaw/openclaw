import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createGateway, createSessions, mountSidebar } from "../test-helpers/app-sidebar.ts";
import "./app-sidebar.tsx";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../test-helpers/native-gateways.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const describeBrowserLayout = chromiumAvailable ? describe : describe.skip;

let browser: Browser;
let page: Page;

const uiCss = ["base.css", "components.css", "layout.css"]
  .map((file) => readStyleSheet(`ui/src/styles/${file}`))
  .join("\n");
async function footerGeometry(includeIdentity = false) {
  return page.evaluate((native) => {
    const box = (selector: string) => {
      const { top, bottom, left, right, height } = document
        .querySelector(selector)!
        .getBoundingClientRect();
      return { top, bottom, left, right, height };
    };
    return {
      shell: box(".sidebar-shell"),
      footer: box(".sidebar-shell__footer"),
      settings: box(".settings-sidebar"),
      settingsFooter: box(".settings-sidebar__footer"),
      card: box(".sidebar-identity-card"),
      action: box(".sidebar-issues-button"),
      identity: native
        ? {
            name: box(".sidebar-identity-card__name"),
            gateway: box(".sidebar-identity-card__gateway"),
            avatar: box(".sidebar-identity-card .viewer-avatar--footer"),
          }
        : null,
      divider: Number.parseFloat(
        getComputedStyle(document.querySelector(".sidebar-shell__footer")!).borderBlockStartWidth,
      ),
    };
  }, includeIdentity);
}

afterAll(async () => {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
});

describeBrowserLayout("sidebar footer layout", () => {
  setupSidebarTest();
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
    page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    await page.setContent(`
      <!doctype html><html data-theme-mode="light"><style>${uiCss}</style>
          <style>
            .footer-layout-fixture {
              display: flex;
              width: 576px;
              height: 220px;
            }
            .footer-layout-fixture > * {
              width: 288px;
              min-height: 0;
            }
          </style>
          <main class="shell footer-layout-fixture">
            <section class="sidebar-shell">
              <div class="sidebar-shell__content"></div>
              <div class="sidebar-shell__footer">
                <div class="sidebar-footer-bar sidebar-footer-bar--one-action">
                  <button class="sidebar-identity-card" type="button">
                    <span class="viewer-avatar viewer-avatar--footer is-fallback"><span class="viewer-avatar__fallback">M</span></span>
                    <span class="sidebar-identity-card__text"><span class="sidebar-identity-card__name">Mason</span></span>
                  </button>
                  <span class="sidebar-footer-actions">
                    <button class="sidebar-issues-button" type="button">
                      <span class="sidebar-issues-button__icon"></span>
                    </button>
                  </span>
                </div>
              </div>
            </section>
            <aside class="settings-sidebar">
              <div class="sidebar-shell__content"></div>
              <footer class="settings-sidebar__footer">
                <openclaw-settings-save-indicator></openclaw-settings-save-indicator>
                <span class="sidebar-footer-build">2026.8.1 · git@5328856</span>
              </footer>
            </aside>
          </main>
      </html>
    `);
  });

  it("lands both sidebar footers on one divider line", async () => {
    const { shell, footer, settings, settingsFooter } = await footerGeometry();
    expect(settingsFooter.height).toBeCloseTo(footer.height, 2);
    // Measure from the shell edge: equal heights alone miss a displaced divider.
    expect(shell.bottom - footer.bottom).toBeCloseTo(0, 2);
    expect(settings.bottom - settingsFooter.top).toBeCloseTo(shell.bottom - footer.top, 2);
  });

  it("centers the account row between the divider and the sidebar edge", async () => {
    const { shell, footer, card, action, divider } = await footerGeometry();
    expect(card.top - footer.top - divider).toBeCloseTo(shell.bottom - card.bottom, 2);
    expect((action.top + action.bottom) / 2).toBeCloseTo((card.top + card.bottom) / 2, 2);
    expect(shell.right - action.right).toBeCloseTo(card.left - shell.left, 2);
  });

  it("fits the rendered native two-line identity inside the 53px footer", async () => {
    setNativeGatewayTestState("local");
    try {
      const { sidebar } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        createSessions("main", ["agent:main:main"]),
      );
      const card = sidebar.querySelector<HTMLElement>(".sidebar-identity-card")!;
      const avatarElement = card.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
        "openclaw-viewer-avatar",
      )!;
      await avatarElement.updateComplete;
      await page.locator(".sidebar-identity-card").evaluate((element, markup) => {
        element.outerHTML = markup;
      }, card.outerHTML);
      const geometry = await footerGeometry(true);
      const { name, gateway, avatar } = geometry.identity!;
      expect([geometry.footer.height, name.height, gateway.height, avatar.height]).toEqual([
        53, 18, 14, 28,
      ]);
      expect(gateway.top).toBeGreaterThanOrEqual(name.bottom);
      expect(geometry.card.top).toBeGreaterThan(geometry.footer.top);
      expect(geometry.card.bottom).toBeLessThan(geometry.footer.bottom);
      for (const content of [name, gateway, avatar]) {
        expect(content.top).toBeGreaterThanOrEqual(geometry.card.top);
        expect(content.bottom).toBeLessThanOrEqual(geometry.card.bottom);
        expect(content.right).toBeLessThanOrEqual(geometry.card.right);
      }
    } finally {
      clearNativeGatewayTestState();
    }
  });
});
