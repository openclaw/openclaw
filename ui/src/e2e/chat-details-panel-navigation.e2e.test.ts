import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Details panel navigation",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:details-panels";

async function setup(page: Page) {
  const frameUrl = new URL("__widget/details-project-overview", suite.server.baseUrl).href;
  await page.route(frameUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: buildWidgetDocument(
        "Project overview",
        `<style>body{margin:0;font:16px system-ui;color:#37342e;background:#faf9f6}main{padding:32px}h1{font-size:32px;color:#37342e}li{padding:12px 0;border-bottom:1px solid #ddd8ce}</style><main><p>PROJECT OVERVIEW · DEMO DATA</p><h1>Ready for review</h1><p>Five project documents are ready. Review the checklist before the next release.</p><ul><li>Project notes — complete</li><li>Release checklist — ready</li><li>Test results — reviewed</li></ul></main>`,
      ),
    }),
  );
  await installMockGateway(page, {
    sessionKey,
    agentModel: "gpt-4.1",
    sessions: [
      {
        key: sessionKey,
        agentId: "main",
        sessionId: "details-panels",
        model: "gpt-4.1",
        modelProvider: "openai",
        kind: "direct",
        updatedAt: 1,
        boardFace: "dashboard",
        boardPresentation: "split",
      },
    ],
    historyMessages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "The project notes and release checklist are ready for review." },
        ],
      },
    ],
    featureMethods: ["board.get", "chat.metadata", "chat.startup", "terminal.open"],
    terminalEnabled: true,
    methodResponses: {
      "cron.list": {
        jobs: [],
        offset: 0,
        limit: 50,
        total: 0,
        hasMore: false,
        nextOffset: null,
        snapshotRevision: "empty",
      },
      "progressCard.get": null,
      "board.get": {
        sessionKey,
        revision: 1,
        tabs: [{ tabId: "main", title: "Project overview", position: 0, chatDock: "right" }],
        widgets: [
          {
            name: "overview",
            tabId: "main",
            title: "Project overview",
            contentKind: "html",
            sizeW: 12,
            sizeH: 8,
            position: 0,
            grantState: "granted",
            revision: 1,
            frameUrl,
          },
        ],
      },
      "artifacts.list": {
        artifacts: [
          "Project notes",
          "Release checklist",
          "Test results",
          "Review summary",
          "Next steps",
        ].map((title, index) => ({
          id: `output-${index}`,
          title: `${title}.md`,
          mimeType: "text/markdown",
          sizeBytes: 512,
          type: "document",
          download: { mode: "bytes" },
        })),
      },
    },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
  await page.locator(".board-session-surface").waitFor();
  await page
    .frameLocator(".board-widget iframe")
    .getByText("Ready for review", { exact: true })
    .waitFor();
}

async function expectBesidePanel(page: Page, details: Locator) {
  await waitForLayoutSettled(page, ".sidebar-region__header, .chat-details");
  const header = await page
    .locator(".sidebar-region__header")
    .filter({ visible: true })
    .boundingBox();
  const panel = await details.boundingBox();
  expect(header).not.toBeNull();
  expect(panel).not.toBeNull();
  expect(panel!.x).toBeGreaterThanOrEqual(header!.x);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(header!.x + header!.width);
}

async function openOutputs(details: Locator) {
  const summary = details.locator('[data-details-group="outputs"] > summary');
  if ((await summary.getAttribute("aria-expanded")) !== "true") {
    await summary.click();
  }
  await details.getByRole("button", { name: "View all", exact: true }).waitFor();
}

suite.define(() => {
  it("opens Files from View all and dismisses Details in Chat and Dashboard", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await setup(page);
      for (const main of ["Chat", "Dashboard"]) {
        if (main === "Dashboard") {
          await openChatSidePanelType(page, "Dashboard");
          await selectChatLayoutAction(page, /^Swap /);
        }
        const details = await openChatDetails(page);
        await openOutputs(details);
        await details.getByRole("button", { name: "View all", exact: true }).click();
        await page.locator('[data-panel-slot="workspace"][data-region="side"]').waitFor();
        await expect.poll(() => details.isVisible()).toBe(false);
        await expect
          .poll(() =>
            page.evaluate(() => document.activeElement?.closest(".chat-details") === null),
          )
          .toBe(true);
      }
    });
  });

  it("keeps Dashboard Details inside the main region across side panel types and resizing", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await setup(page);
      await selectChatLayoutAction(page, /^Swap /);
      await page.locator('[data-panel-slot="dashboard"][data-region="main"]').waitFor();
      // The main conversation occupies the side region immediately after swapping.
      await expectBesidePanel(page, await openChatDetails(page));
      for (const side of ["Files", "Terminal", "Side chat"]) {
        await openChatSidePanelType(page, side);
        await expectBesidePanel(page, await openChatDetails(page));
      }
      await page.setViewportSize({ width: 1180, height: 800 });
      await expectBesidePanel(page, await openChatDetails(page));
      await selectChatLayoutAction(page, "Minimize side panel");
      await expectBesidePanel(page, await openChatDetails(page));
      await selectChatLayoutAction(page, "Side panel");
      await expectBesidePanel(page, await openChatDetails(page));
    });
  });
});
