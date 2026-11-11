import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createBoardWidget } from "../lib/board/widget.test-support.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { board as emptyBoard, seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Workboard board widget layout",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:dashboard:workboard-layout";
const boardSnapshot = emptyBoard(sessionKey, [
  createBoardWidget({
    name: "workboard-board",
    title: "Platform board",
    contentKind: "plugin",
    pluginKind: "workboard:board",
    props: { boardId: "platform" },
    sizeW: 12,
    sizeH: 5,
  }),
]);

const statuses = ["ready", "running", "done"] as const;
const cards = statuses.map((status, index) => ({
  id: `card-${status}`,
  title: `${status} card`,
  status,
  priority: "normal",
  labels: [],
  position: (index + 1) * 1_000,
  createdAt: 1,
  updatedAt: 2,
  agentId: "main",
  metadata: { automation: { boardId: "platform" } },
}));

suite.define(() => {
  it("keeps paged cards visible in the compact grid at desktop and mobile widths", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      const cursor = { position: cards[1]!.position, createdAt: 1, id: cards[1]!.id };
      const firstPage = { cards: cards.slice(0, 2), statuses, nextCursor: cursor };
      const readyCards = Array.from({ length: 6 }, (_, index) => ({
        ...cards[0]!,
        id: `ready-page-${index}`,
        title: `Ready page card ${index + 1}`,
        position: (index + 4) * 1000,
      }));
      const lastPage = { cards: [...cards.slice(2), ...readyCards], statuses };
      await installNativePluginMockGateway(page, {
        ...workboardUi,
        sessionKey,
        controlUiWidgetKinds: [
          { pluginId: "workboard", kind: "workboard:board", label: "Workboard board" },
        ],
        featureMethods: ["board.get", "chat.metadata", "chat.startup", "workboard.cards.list"],
        methodResponses: {
          "board.get": boardSnapshot,
          "workboard.cards.list": {
            cases: [
              { match: { sessionKey }, response: { cards: [] } },
              { match: { after: cursor }, response: lastPage },
              { response: firstPage },
            ],
          },
        },
      });
      await seedChatSettings(page, suite.server.baseUrl, {
        boardSessionViews: { [sessionKey]: { activeTabId: "main" } },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));

      const board = page.locator('[data-test-id="workboard-board-widget"] .workboard-board');
      await board.waitFor();
      const loadMore = page.getByRole("button", { name: "Load more cards", exact: true });
      await loadMore.waitFor();
      for (const width of [1280, 700]) {
        await page.setViewportSize({ height: 900, width });
        const layout = await board.evaluate((element) => {
          const columns = [...element.querySelectorAll(".workboard-column")].map((column) =>
            column.getBoundingClientRect(),
          );
          const bottom = element
            .querySelector(".workboard-card__title")!
            .getBoundingClientRect().bottom;
          const widgetBottom = element
            .closest(".workboard-widget-board")!
            .getBoundingClientRect().bottom;
          const style = getComputedStyle(element);
          return {
            display: style.display,
            flow: style.gridAutoFlow,
            cardVisible: bottom > 0 && bottom <= widgetBottom,
            widthsMatch: columns.every((column) => column.width >= 239 && column.width <= 241),
            sameRow: columns[0]?.top === columns[1]?.top,
            secondVisible: (columns[1]?.left ?? 0) > 0,
          };
        });
        expect(layout).toMatchObject({
          display: "grid",
          cardVisible: true,
          ...(width === 1280
            ? { flow: "column", widthsMatch: true }
            : { sameRow: true, secondVisible: true }),
        });
      }
      await loadMore.click();
      await expect.poll(() => board.locator(".workboard-card").count()).toBe(9);
      expect(await loadMore.count()).toBe(0);
      const ready = board.locator(".workboard-column--ready .workboard-column__cards");
      await expect
        .poll(() =>
          ready.evaluate((element) => ({
            overflows: element.scrollHeight > element.clientHeight + 1,
            scrollable: element.hasAttribute("data-scrollable"),
            bottom: element.style.getPropertyValue("--workboard-fade-bottom"),
          })),
        )
        .toEqual({ overflows: true, scrollable: true, bottom: "24px" });
      expect(
        await ready.evaluate((element) => {
          const viewport = element.getBoundingClientRect();
          return [...element.querySelectorAll(".workboard-card")].every((card) => {
            const bounds = card.getBoundingClientRect();
            return bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1;
          });
        }),
      ).toBe(true);
      await ready.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect
        .poll(() =>
          ready
            .locator(".workboard-card")
            .last()
            .evaluate((card) => {
              const viewport = card.closest(".workboard-column__cards")!.getBoundingClientRect();
              const bounds = card.getBoundingClientRect();
              return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom + 1;
            }),
        )
        .toBe(true);
    });
  });
  it.each([
    { name: "desktop", width: 1400, height: 1000, colorScheme: "dark", native: true },
    { name: "tablet", width: 820, height: 1000, colorScheme: "light", native: false },
    { name: "phone", width: 390, height: 844, colorScheme: "dark", native: false },
  ] as const)("keeps the mini widget Open board target clear on $name", async (mode) => {
    await suite.withPage({ viewport: mode, colorScheme: mode.colorScheme }, async ({ page }) => {
      if (mode.native) {
        await installNativeWebChrome(page);
      }
      const mini = createBoardWidget({
        name: "workboard-mini",
        title: "Platform board",
        contentKind: "plugin",
        pluginKind: "workboard:mini",
        props: { boardId: "platform" },
        sizeW: 12,
        sizeH: 5,
      });
      await installNativePluginMockGateway(page, {
        ...workboardUi,
        sessionKey,
        controlUiWidgetKinds: [
          { pluginId: "workboard", kind: "workboard:mini", label: "Workboard summary" },
        ],
        featureMethods: ["board.get", "chat.metadata", "chat.startup", "workboard.cards.list"],
        methodResponses: {
          "board.get": {
            ...emptyBoard(sessionKey, [mini]),
            tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "hidden" }],
          },
          "workboard.cards.list": { cards, statuses, boards: [] },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      const link = page.locator(".workboard-widget-mini header a");
      const menu = page.getByRole("button", { name: "Dashboard options", exact: true });
      await link.waitFor();
      await menu.waitFor();
      await page.mouse.move(0, 0);
      const frame = await takeControlUiScreenshotFrame(
        page,
        page.locator("openclaw-app"),
        [link, menu],
        { animations: "disabled" },
      );
      writeFileSync(
        path.join(suite.artifactDir, "dashboard-mini-" + mode.name + ".png"),
        frame.png,
      );
      const proof = await link.evaluate((element) => {
        const target = element.getBoundingClientRect();
        const menuBounds = document
          .querySelector(".chat-dashboard-menu__trigger")!
          .getBoundingClientRect();
        const x = target.left + target.width / 2,
          y = target.top + target.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          x,
          y,
          overlap:
            Math.max(
              0,
              Math.min(target.right, menuBounds.right) - Math.max(target.left, menuBounds.left),
            ) *
            Math.max(
              0,
              Math.min(target.bottom, menuBounds.bottom) - Math.max(target.top, menuBounds.top),
            ),
          receivesClick: hit === element || element.contains(hit),
          canvasClear:
            document.querySelector(".board-session-surface__board")!.getBoundingClientRect().top >=
            menuBounds.bottom,
          nativeFlag: Reflect.get(window, "__OPENCLAW_NATIVE_WEB_CHROME__") === true,
          nativeStyle: Boolean(document.getElementById("openclaw-native-macos-chrome")),
          classes: document.documentElement.className,
          inset: getComputedStyle(document.documentElement)
            .getPropertyValue("--openclaw-native-titlebar-height")
            .trim(),
        };
      });
      const destination = await link.getAttribute("href");
      await page.mouse.click(proof.x, proof.y);
      const menuOpened =
        (await page.locator('.chat-dashboard-menu__trigger[aria-expanded="true"]').count()) > 0;
      writeFileSync(
        path.join(suite.artifactDir, "dashboard-mini-" + mode.name + ".json"),
        JSON.stringify({ ...proof, menuOpened, destination }, null, 2),
      );
      expect(proof.overlap).toBe(0);
      expect(proof.receivesClick).toBe(true);
      expect(proof.canvasClear).toBe(true);
      expect(menuOpened).toBe(false);
      await expect.poll(() => page.url()).toBe(new URL(destination!, suite.server.baseUrl).href);
      await page.locator(".workboard").waitFor();
      if (mode.native) {
        expect(proof.classes.split(" ")).toEqual(
          expect.arrayContaining(["openclaw-native-macos", "openclaw-native-web-chrome"]),
        );
        expect(proof.inset).toBe("52px");
        expect(proof.nativeFlag && proof.nativeStyle).toBe(true);
      }
    });
  });
});
