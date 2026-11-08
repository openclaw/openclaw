import { expect, it } from "vitest";
import { withBrowserPage } from "../test-helpers/browser-page.ts";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("onboarding-layout-");
const css = readStyles("styles/base", "styles/layout", "styles/layout.mobile", "styles/custodian");

fixture.describe("onboarding handoff", () => {
  it.each([400, 820, 1280])(
    "keeps the focusable frame and page inset stable at %i px",
    async (width) => {
      await withBrowserPage(fixture.page({ viewport: { width, height: 1000 } }), async (page) => {
        await page.setContent(styleDocument(css, ""));
        const bounds = await page.evaluate(async (pageWidth) => {
          const settle = () =>
            new Promise<void>((resolve) => {
              setTimeout(resolve, 50);
            });
          const rect = (element: Element) => {
            const box = element.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height };
          };
          const shell = document.createElement("div");
          const mobile = pageWidth <= 900 ? " shell--mobile-nav" : "";
          shell.className = `shell shell--onboarding${mobile}`;
          shell.style.cssText =
            "height:1000px;--shell-nav-expanded-width:310px;--shell-nav-rail-width:52px";
          const main = document.createElement("main");
          main.className = "content content--custodian";
          main.tabIndex = -1;
          const outlet = document.createElement("openclaw-router-outlet");
          const onboarding = document.createElement("openclaw-custodian-page");
          onboarding.textContent = "Set up your agent";
          outlet.append(onboarding);
          main.append(outlet);
          shell.append(main);
          document.body.append(shell);
          await settle();
          main.focus();
          const setup = rect(onboarding);
          const setupFocused = document.activeElement === main;
          const shifts: number[] = [];
          const observer = new PerformanceObserver((entries) => {
            for (const entry of entries.getEntries()) {
              shifts.push(Number(Reflect.get(entry, "value")));
            }
          });
          observer.observe({ type: "layout-shift" });
          const chat = document.createElement("div");
          chat.style.cssText = "flex:1;min-height:0";
          chat.textContent = "Chat composer";
          outlet.replaceChildren(chat);
          main.className = "content content--chat content--workbench";
          shell.className = `shell shell--navigation-rail shell--chat shell--session shell--merged-chat-chrome${mobile}`;
          await settle();
          shifts.push(
            ...observer.takeRecords().map((entry) => Number(Reflect.get(entry, "value"))),
          );
          observer.disconnect();
          main.focus();
          return {
            setup,
            setupFocused,
            chat: rect(chat),
            main: rect(main),
            chatFocused: document.activeElement === main,
            retained: main.firstChild === outlet,
            cls: shifts.reduce((sum, value) => sum + value, 0),
          };
        }, width);
        expect(bounds.setup).toEqual({ x: 0, y: 0, width, height: 1000 });
        expect(bounds.main).toEqual({ x: 0, y: 0, width, height: 1000 });
        expect(bounds.chat.x).toBe(width <= 900 ? 0 : 310);
        expect(bounds.chat.width).toBe(width <= 900 ? width : width - 310);
        expect(bounds.setupFocused && bounds.chatFocused && bounds.retained).toBe(true);
        expect(bounds.cls).toBe(0);
      });
    },
  );
});
