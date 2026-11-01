import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { chatFixture, newChatPage, sessionRow } from "./chat-flow-fixtures.test-support.ts";
import {
  chatSessionListResponse,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:session-a";
const parentLabel = "Release readiness and production rollout coordination";
const workspaceRow = (key: string, label: string, updatedAt: number, fields = {}) =>
  sessionRow(key, label, updatedAt, { spawnedCwd: "/repo/openclaw", ...fields });
const compactPage = (viewport: { width: number; height: number }) =>
  chatFixture(suite, { sessions: chatSessionListResponse().sessions }, { viewport });
suite.define(() => {
  it.each([1000, 390])("lays out session identity at %i px", async (width) => {
    const { page } = await newChatPage(suite, {
      viewport: { height: 520, width },
    });
    const favicon = await readFile(path.resolve(process.cwd(), "ui/public/favicon.svg"));
    await page.route("**/__openclaw__/workspace-icon/**", async (route) => {
      await route.fulfill({ body: favicon, contentType: "image/svg+xml", status: 200 });
    });
    await installMockGateway(page, {
      sessions: [
        workspaceRow("agent:main:parent", parentLabel, 1),
        workspaceRow(
          sessionKey,
          "Implement parent breadcrumb navigation and polish overflow behavior",
          2,
          { parentSessionKey: "agent:main:parent" },
        ),
      ],
      sessionKey,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
    const desktop = width === 1000;
    const header = pane.locator(desktop ? ".chat-pane__header" : ".agent-chat__header--mobile");
    const titleSelector = desktop ? ".chat-pane__session-title-text" : ".mobile-header__title-text";
    const title = header.locator(titleSelector);
    await header.waitFor();
    await header.locator(desktop ? ".workspace-icon" : ".chat-pane__workspace-chip").waitFor();

    if (!desktop) {
      const gaps = await header.evaluate((root) => {
        const rect = (selector: string) => root.querySelector(selector)!.getBoundingClientRect();
        const identity = rect(".mobile-header__identity");
        return [
          identity.left - rect(".mobile-header__navigation").right,
          rect(".mobile-header__capsule").left - identity.right,
        ];
      });
      for (const gap of gaps) {
        expect(gap).toBeGreaterThanOrEqual(0);
      }
      return;
    }

    const geometry = await header.evaluate((root) => {
      const main = root
        .closest("openclaw-chat-pane")
        ?.querySelector('[data-region="main"]:not([hidden])');
      if (!main) {
        throw new Error("Task header requires visible main content");
      }
      const element = (selector: string) => {
        const node = root.querySelector(selector);
        if (!node) {
          throw new Error(`missing header element: ${selector}`);
        }
        return node;
      };
      const rect = (selector: string) => element(selector).getBoundingClientRect();
      const centerY = (selector: string) => {
        const { top, height } = rect(selector);
        return top + height / 2;
      };
      return {
        nav: centerY(".chat-details-toggle svg"),
        menu: centerY(".chat-header-session-menu__trigger svg"),
        headerBottom: root.getBoundingClientRect().bottom,
        headerOverflow: root.scrollWidth - root.clientWidth,
        titleWidth: rect(".chat-pane__session-title-text").width,
        contentTop: main.getBoundingClientRect().top,
      };
    });

    expect(Math.abs(geometry.menu - geometry.nav)).toBeLessThanOrEqual(0.1);
    expect(geometry.contentTop).toBeGreaterThanOrEqual(geometry.headerBottom - 0.1);
    expect(geometry.headerOverflow).toBeLessThanOrEqual(1);
    expect(geometry.titleWidth).toBeGreaterThan(0);
    const parent = header.locator(".chat-pane__parent-session");
    expect((await parent.textContent())?.trim()).toBe(parentLabel);
    await parent.click();
    await expect.poll(() => title.textContent()).toBe(parentLabel);
  });

  for (const viewport of [
    { height: 844, label: "portrait", width: 390 },
    { height: 393, label: "short landscape", width: 852 },
  ] as const) {
    it(`keeps compact ${viewport.label} transcript search below the task header`, async () => {
      const { page } = await compactPage(viewport);

      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__composer-combobox > textarea").focus();
      await page.keyboard.press("ControlOrMeta+f");
      const search = page.locator(".agent-chat__search-bar input");
      await search.waitFor();
      const [headerBox, searchBox] = await Promise.all([
        page.locator(".agent-chat__header--mobile").filter({ visible: true }).boundingBox(),
        search.boundingBox(),
      ]);
      expect(headerBox).not.toBeNull();
      expect(searchBox).not.toBeNull();
      expect(searchBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
      await search.click();
      await search.fill("reachable");
      expect(await search.inputValue()).toBe("reachable");
    });

    it(`preserves compact ${viewport.label} New Session composer edge margins`, async () => {
      const { context, page } = await compactPage(viewport);

      await page.goto(`${suite.server.baseUrl}new`);
      const protocol = await context.newCDPSession(page);
      await protocol.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 34 } });
      const composer = page.locator(".new-session-page__composer");
      await composer.waitFor();
      await composer.scrollIntoViewIfNeeded();
      const bounds = await composer.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          draftBottom: element.closest(".new-session-page__draft")!.getBoundingClientRect().bottom,
          shellBottom: element.closest(".shell")!.getBoundingClientRect().bottom,
        };
      });
      // The draft's chat-composer gap must not reserve the physical inset again.
      expect(bounds.shellBottom).toBeCloseTo(viewport.height - 34, 0);
      expect(bounds.draftBottom - bounds.bottom).toBeCloseTo(10, 0);
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.shellBottom);
      expect(bounds.left).toBeGreaterThanOrEqual(20);
      expect(bounds.right).toBeLessThanOrEqual(viewport.width - 20);
      expect(bounds.left).toBeCloseTo(viewport.width - bounds.right, 0);
    });
  }
});
