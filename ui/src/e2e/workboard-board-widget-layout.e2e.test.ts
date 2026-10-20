import { expect, it } from "vitest";
import { createWorkboardCard } from "../../../extensions/workboard/browser/lib/workboard/test/index-helpers.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { board as emptyBoard, seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Workboard board widget layout",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:dashboard:workboard-layout";
const boardSnapshot = {
  ...emptyBoard(sessionKey),
  widgets: [
    {
      name: "workboard-board",
      tabId: "main",
      title: "Platform board",
      contentKind: "plugin",
      pluginKind: "workboard:board",
      props: { boardId: "platform" },
      sizeW: 12,
      sizeH: 5,
      position: 0,
      grantState: "none",
      revision: 1,
    },
  ],
};

const statuses = ["ready", "running", "done"] as const;
const cards = statuses.map((status, index) =>
  createWorkboardCard({
    id: `card-${status}`,
    title: `${status} card`,
    status,
    position: (index + 1) * 1_000,
    agentId: "main",
    metadata: { automation: { boardId: "platform" } },
  }),
);

suite.define(() => {
  it("keeps paged cards visible in the compact grid at desktop and mobile widths", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      const cursor = { position: cards[1]!.position, createdAt: 1, id: cards[1]!.id };
      const firstPage = { cards: cards.slice(0, 2), statuses, nextCursor: cursor };
      const lastPage = { cards: cards.slice(2), statuses };
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
      await expect.poll(() => board.locator(".workboard-card").count()).toBe(3);
      expect(await loadMore.count()).toBe(0);
    });
  });
});
