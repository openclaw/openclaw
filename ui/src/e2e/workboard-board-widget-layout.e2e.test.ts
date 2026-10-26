import { expect, it } from "vitest";
import { createBoardWidget } from "../lib/board/widget.test-support.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { board as emptyBoard, seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

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
      await installMockGateway(page, {
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
});
