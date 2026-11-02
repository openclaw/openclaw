import type { Locator } from "playwright";
import { expect, it, vi } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { textMessage } from "./chat-flow-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Transcript focused row placement",
  startServerBeforeBrowser: true,
});
async function focusRow(action: Locator) {
  await action.focus();
  const key = await action.evaluate(
    (element) => element.closest<HTMLElement>(".chat-virtual-row")?.dataset.virtualRowKey ?? "",
  );
  expect(key).not.toBe("");
  return key;
}
suite.define(() => {
  it("keeps a focused message action mounted while its row scrolls out of view", async () => {
    const page = await suite.browser.newPage({ viewport: { width: 1280, height: 800 } });
    const messages = Array.from({ length: 200 }, (_, index) =>
      textMessage(
        index % 2 === 0 ? "assistant" : "user",
        `focus retention message ${index + 1}\n${"transcript detail line\n".repeat(3)}`,
        { __openclaw: { seq: index + 1 }, timestamp: Date.now() + index },
      ),
    );
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup"],
      methodResponses: {
        "chat.startup": {
          messages,
          hasMore: false,
          totalMessages: messages.length,
          sessionId: "focus-retention",
          thinkingLevel: null,
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await page.getByText(/^focus retention message 200\n/).waitFor();
    const thread = page.locator(".chat-thread");
    const actions = thread.locator("button.chat-reply-btn");
    const scrollTo = async (edge: "first" | "last", dispatch = false) => {
      await thread.evaluate((element, atStart) => {
        element.scrollTop = atStart ? 0 : element.scrollHeight;
      }, edge === "first");
      if (dispatch) {
        await thread.evaluate((element) => element.dispatchEvent(new Event("scroll")));
        await expect
          .poll(() => thread.evaluate((element) => Math.round(element.scrollTop)))
          .toBe(0);
      }
      await page
        .getByText(
          edge === "first" ? /^focus retention message 1\n/ : /^focus retention message 200\n/,
        )
        .waitFor({ state: "visible" });
    };

    const checkPlacement = async (
      edge: "first" | "last",
      sparse: boolean,
      expectedRowKey: string,
    ) => {
      // Visibility alone can pass on a stale range containing the focused outlier.
      await vi.waitFor(async () => {
        const placement = await thread.evaluate(
          (element, { edge: placementEdge, sparse: isSparse }) => {
            const rows = [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")];
            const range = element
              .querySelector<HTMLElement>(".chat-thread-inner--virtual")!
              .getBoundingClientRect();
            const focused = document.activeElement?.closest<HTMLElement>(".chat-virtual-row");
            const edgeRow = placementEdge === "first" ? rows[0]! : rows.at(-1)!;
            const normalRows = isSparse ? rows.filter((row) => row !== edgeRow) : rows;
            const viewportTop = element.getBoundingClientRect().top + element.clientTop;
            const viewportBottom = viewportTop + element.clientHeight;
            const atStart = isSparse ? placementEdge === "last" : placementEdge === "first";
            const gaps = rows.slice(1).map((row, index) => ({
              skipped: Number(row.dataset.index) - Number(rows[index]!.dataset.index) - 1,
              pixels: row.getBoundingClientRect().top - rows[index]!.getBoundingClientRect().bottom,
            }));
            return {
              focused: focused === edgeRow,
              focusedRowKey: focused?.dataset.virtualRowKey,
              edgeDelta:
                placementEdge === "first"
                  ? edgeRow.getBoundingClientRect().top - range.top
                  : range.bottom - edgeRow.getBoundingClientRect().bottom,
              scrollEdgeDelta: atStart
                ? element.scrollTop
                : element.scrollHeight - element.clientHeight - element.scrollTop,
              // Scroller padding is not missing transcript content.
              uncovered: [
                normalRows[0]!.getBoundingClientRect().top - Math.max(viewportTop, range.top),
                Math.min(viewportBottom, range.bottom) -
                  normalRows.at(-1)!.getBoundingClientRect().bottom,
              ],
              gaps,
              count: rows.length,
            };
          },
          { edge, sparse },
        );
        expect(placement).toMatchObject({ focused: true, focusedRowKey: expectedRowKey });
        expect(Math.abs(placement.edgeDelta)).toBeLessThanOrEqual(2);
        expect(placement.count).toBeLessThan(30);
        expect(placement.gaps.filter((gap) => gap.skipped > 0)).toHaveLength(sparse ? 1 : 0);
        for (const [index, gap] of placement.gaps.entries()) {
          if (gap.skipped > 0) {
            expect(index).toBe(edge === "first" ? 0 : placement.gaps.length - 1);
            expect(gap.pixels).toBeGreaterThan(1000);
          } else {
            expect(gap.skipped).toBe(0);
            expect(Math.abs(gap.pixels)).toBeLessThanOrEqual(1);
          }
        }
        expect(Math.abs(placement.scrollEdgeDelta)).toBeLessThanOrEqual(1);
        expect(Math.max(...placement.uncovered)).toBeLessThanOrEqual(2);
      });
    };
    for (const edge of ["last", "first"] as const) {
      await scrollTo(edge);
      const key = await focusRow(actions[edge]());
      await scrollTo(edge === "last" ? "first" : "last", edge === "last");
      await checkPlacement(edge, true, key);
      await scrollTo(edge);
      await checkPlacement(edge, false, key);
    }
    await page.close();
  });
});
