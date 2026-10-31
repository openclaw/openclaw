import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("fills the narrow viewport with the active split and restores desktop geometry and drafts", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const sessions = ["a", "b", "c"].map((suffix) => ({
          key: `agent:main:session-${suffix}`,
          kind: "direct",
          label: `Session ${suffix}`,
          updatedAt: 1,
        }));
        const columns = [
          { id: "c1", indexes: [0], paneWeights: [1] },
          { id: "c2", indexes: [1, 2], paneWeights: [0.4, 0.6] },
        ].map(({ id, indexes, paneWeights }) => ({
          id,
          paneWeights,
          panes: indexes.map((index) => ({
            id: `p${index + 1}`,
            sessionKey: sessions[index]!.key,
          })),
        }));
        await seedChatSettings(page, suite.server.baseUrl, {
          chatSplitLayout: {
            activePaneId: "p3",
            columns,
            columnWeights: [0.35, 0.65],
          },
        });
        await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: "Responsive split proof." }],
          methodResponses: {
            "sessions.list": chatSessionListResponse(sessions),
          },
          sessionKey: "agent:main:session-c",
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-c"));
        const cells = page.locator(".chat-split-view__cell");
        const composers = cells.locator(".agent-chat__composer-combobox textarea");
        await expect.poll(() => composers.count()).toBe(3);
        const historyLength = await page.evaluate(() => history.length);
        const drafts = ["Left draft stays unsent", "Active lower-right draft stays unsent"];
        // Focus back before the first navigation can finish loading its route.
        await composers.evaluateAll((nodes, texts) => {
          for (const [index, text] of texts.entries()) {
            const node = nodes[index * 2];
            if (!(node instanceof HTMLTextAreaElement)) {
              throw new Error("Expected split composers");
            }
            node.focus();
            node.value = text;
            node.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
          }
        }, drafts);
        await expect.poll(() => cells.last().getAttribute("class")).toContain("--active");
        const geometry = () =>
          cells.evaluateAll((nodes) =>
            nodes.map((node) => {
              const bounds = node.getBoundingClientRect();
              return [bounds.x, bounds.y, bounds.width, bounds.height];
            }),
          );
        const desktop = await geometry();
        await page.setViewportSize({ height: 900, width: 1000 });
        const visibleCells = () =>
          Promise.all([cells.first(), cells.nth(1), cells.last()].map((cell) => cell.isVisible()));
        await expect.poll(visibleCells).toEqual([false, false, true]);
        await expect
          .poll(() =>
            cells.last().evaluate((cell) => {
              const parent = cell.closest(".chat-split-view")!.getBoundingClientRect();
              const active = cell.getBoundingClientRect();
              return [
                Math.round(parent.width - active.width),
                Math.round(parent.height - active.height),
              ];
            }),
          )
          .toEqual([0, 0]);
        for (const cell of [cells.first(), cells.nth(1)]) {
          expect(await cell.locator("openclaw-chat-pane").getAttribute("inert")).not.toBeNull();
        }
        const activePane = cells.last().locator("openclaw-chat-pane:not([inert])");
        expect(await activePane.evaluate((pane) => Reflect.get(pane, "sessionKey"))).toBe(
          "agent:main:session-c",
        );
        expect(new URL(page.url()).pathname).toBe("/chat/main/session-c");
        expect(await page.evaluate(() => history.length)).toBe(historyLength);
        expect(await composers.last().inputValue()).toBe(drafts[1]);
        await page.setViewportSize({ height: 900, width: 1440 });
        await expect.poll(visibleCells).toEqual([true, true, true]);
        await expect.poll(geometry).toEqual(desktop);
        expect([await composers.first().inputValue(), await composers.last().inputValue()]).toEqual(
          drafts,
        );
      },
    );
  });
});
