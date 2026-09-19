import path from "node:path";
import { expect, it } from "vitest";
import type { ComposerEditor } from "../components/composer-editor.ts";
import { composerValue } from "../test-helpers/composer-editor.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("fills the narrow viewport with the active split and restores desktop geometry and drafts", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    await context.addInitScript((settingsKey) => {
      localStorage.setItem(
        settingsKey,
        JSON.stringify({
          chatSplitLayout: {
            activePaneId: "p3",
            columns: [
              {
                id: "c1",
                panes: [{ id: "p1", sessionKey: "agent:main:session-a" }],
                paneWeights: [1],
              },
              {
                id: "c2",
                panes: [
                  { id: "p2", sessionKey: "agent:main:session-b" },
                  { id: "p3", sessionKey: "agent:main:session-c" },
                ],
                paneWeights: [0.4, 0.6],
              },
            ],
            columnWeights: [0.35, 0.65],
          },
        }),
      );
    }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [{ role: "assistant", content: "Responsive split proof." }],
      methodResponses: {
        "sessions.list": chatSessionListResponse(
          ["a", "b", "c"].map((suffix) => ({
            key: `agent:main:session-${suffix}`,
            kind: "direct",
            label: `Session ${suffix}`,
            updatedAt: 1,
          })),
        ),
      },
      sessionKey: "agent:main:session-c",
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-c"));
      const cells = page.locator(".chat-split-view__cell");
      const composers = cells.locator(".agent-chat__composer-combobox openclaw-composer-editor");
      await expect.poll(() => composers.count()).toBe(3);
      const historyLength = await page.evaluate(() => history.length);
      // Focus back before the first navigation can finish loading its route.
      await composers.evaluateAll((nodes) => {
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (
          !(
            first instanceof
            (customElements.get("openclaw-composer-editor") as typeof ComposerEditor)
          ) ||
          !(
            last instanceof
            (customElements.get("openclaw-composer-editor") as typeof ComposerEditor)
          )
        ) {
          throw new Error("Expected split composers");
        }
        first.focus();
        first.value = "Left draft stays unsent";
        first.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        last.focus();
        last.value = "Active lower-right draft stays unsent";
        last.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      });
      await expect.poll(() => cells.last().getAttribute("class")).toContain("--active");
      const geometry = () =>
        cells.evaluateAll((nodes) =>
          nodes.map((node) => {
            const { x, y, width, height } = node.getBoundingClientRect();
            return { x, y, width, height };
          }),
        );
      const desktop = await geometry();
      await page.setViewportSize({ height: 900, width: 1000 });
      await expect.poll(() => cells.first().isVisible()).toBe(false);
      await expect.poll(() => cells.nth(1).isVisible()).toBe(false);
      await expect.poll(() => cells.last().isVisible()).toBe(true);
      await expect
        .poll(() =>
          cells.last().evaluate((cell) => {
            const parent = cell.closest(".chat-split-view")!.getBoundingClientRect();
            const active = cell.getBoundingClientRect();
            return {
              width: Math.round(parent.width - active.width),
              height: Math.round(parent.height - active.height),
            };
          }),
        )
        .toEqual({ width: 0, height: 0 });
      expect(
        await cells.first().locator("openclaw-chat-pane").getAttribute("inert"),
      ).not.toBeNull();
      expect(await cells.nth(1).locator("openclaw-chat-pane").getAttribute("inert")).not.toBeNull();
      await page.screenshot({
        path: path.join(createControlUiE2eArtifactDir("split-rapid-focus"), "narrow.png"),
      });
      expect(
        await cells
          .last()
          .locator("openclaw-chat-pane:not([inert])")
          .evaluate((pane) => Reflect.get(pane, "sessionKey")),
      ).toBe("agent:main:session-c");
      expect(new URL(page.url()).pathname).toBe("/chat/main/session-c");
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      expect(await composerValue(composers.last())).toBe("Active lower-right draft stays unsent");
      await page.setViewportSize({ height: 900, width: 1440 });
      await expect.poll(() => cells.first().isVisible()).toBe(true);
      await expect.poll(() => cells.nth(1).isVisible()).toBe(true);
      await expect.poll(geometry).toEqual(desktop);
      expect(await composerValue(composers.first())).toBe("Left draft stays unsent");
      expect(await composerValue(composers.last())).toBe("Active lower-right draft stays unsent");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
