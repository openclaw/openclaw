import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { createBoardWidget } from "../lib/board/widget.test-support.ts";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { recordControlUiE2eFailureFacts } from "../test-helpers/control-ui-e2e-diagnostics.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { captureUiProofEnabled, chatMessage } from "./chat-flow.test-support.ts";
import { layoutBox, right } from "./chat-presentation.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openProgressHomeDock } from "./session-progress-home.test-support.ts";

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
      chatMessage("assistant", "The project notes and release checklist are ready for review."),
    ],
    featureMethods: [
      "board.get",
      "chat.metadata",
      "chat.startup",
      "sessions.companion.state",
      "terminal.open",
    ],
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
          createBoardWidget({
            name: "overview",
            title: "Project overview",
            sizeW: 12,
            sizeH: 8,
            grantState: "granted",
            frameUrl,
          }),
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
  await page
    .locator(".chat-pane-cache__pane--visible .chat-group.assistant .chat-text", {
      hasText: "The project notes and release checklist are ready for review.",
    })
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
  // The row is visible before its disclosure finishes changing height.
  await waitForLayoutSettled(details.page(), '[data-details-group="outputs"]');
}

suite.define(() => {
  it("keeps Details beside Home when the conversation has room", async () => {
    await suite.withPage(
      { colorScheme: "dark", viewport: { width: 1920, height: 960 } },
      async ({ page }) => {
        await installMockGateway(page, {
          sessionKey,
          sessions: [
            { key: sessionKey, label: "Release checklist review", kind: "direct", updatedAt: 1 },
          ],
          historyMessages: [
            chatMessage("user", "Is the release checklist ready to review?"),
            chatMessage(
              "assistant",
              "Yes. The project notes and release checklist are ready. The only item left is confirming the rollout owner.",
            ),
          ],
          featureMethods: ["chat.history", "chat.metadata", "chat.startup"],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const pane = page.locator(".chat-pane-cache__pane--active");
        const composerShell = pane.locator(".agent-chat__composer-shell");
        const composer = pane.locator(".agent-chat__composer-combobox textarea");
        const transcript = pane.locator(".chat-thread-inner");
        const details = pane.locator(".chat-details");
        const trigger = pane.getByRole("button", { name: "Details", exact: true });
        const home = page.locator(".assistant-panel--right");
        await pane
          .getByText("Is the release checklist ready to review?", { exact: true })
          .waitFor();
        await details.waitFor();
        const composerWidth = (await layoutBox(composerShell)).width;
        await openProgressHomeDock(page);
        await home.waitFor();
        await waitForLayoutSettled(
          page,
          ".assistant-panel--right, .chat-main__conversation-frame, .chat-details",
        );
        expect(await trigger.getAttribute("aria-expanded")).toBe("true");
        expect(await details.getAttribute("role")).toBe("complementary");
        const panel = await layoutBox(details);
        expect((await layoutBox(composerShell)).width).toBeCloseTo(composerWidth, 0);
        expect(right(await layoutBox(transcript))).toBeLessThanOrEqual(panel.x);
        expect(right(panel)).toBeLessThanOrEqual((await layoutBox(home)).x);
        const empty = details.getByText("No session details to show.", { exact: true });
        await empty.waitFor();
        if (captureUiProofEnabled) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".shell"),
            [composer, empty, home],
            { animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, "after.png"), frame.png);
        }

        // At 1650px Home leaves 1158px for chat, below the old 1200px cutoff.
        await page.setViewportSize({ width: 1650, height: 960 });
        await waitForLayoutSettled(page, ".assistant-panel--right, .chat-main__conversation-frame");
        expect(await details.getAttribute("role")).toBe("complementary");
        expect((await layoutBox(composerShell)).width).toBeCloseTo(composerWidth, 0);
        await composer.fill("Keep this draft while resizing.");
        await page.setViewportSize({ width: 1280, height: 960 });
        await details.waitFor({ state: "hidden" });
        await trigger.click();
        await details.waitFor();
        expect(await details.getAttribute("role")).toBe("dialog");
        await page.setViewportSize({ width: 1650, height: 960 });
        await expect.poll(() => details.getAttribute("role")).toBe("complementary");
        expect(await composer.inputValue()).toBe("Keep this draft while resizing.");
        expect(await home.isVisible()).toBe(true);
      },
    );
  });

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
        expect(await details.locator(".chat-details-desktop-empty").isVisible()).toBe(false);
        await details.getByRole("button", { name: "View all", exact: true }).click();
        try {
          await page.locator('[data-panel-slot="workspace"][data-region="side"]').waitFor();
        } catch (error) {
          recordControlUiE2eFailureFacts(page, {
            detailsViewAllDashboardCase: main === "Dashboard",
          });
          await withTimeout(
            page.evaluate(() => {
              const nodes = document.querySelectorAll<HTMLElement>(
                "[data-panel-slot][data-region]",
              );
              const panels = [...nodes]
                .slice(0, 32)
                .filter((panel) => panel.checkVisibility({ visibilityProperty: true }));
              const facts: Record<string, boolean | number | null> = {
                detailsViewAllPanelsTruncated: nodes.length > 32,
                detailsViewAllVisiblePanels: panels.length,
                detailsViewAllDetailsVisible: [...document.querySelectorAll(".chat-details")].some(
                  (detailsPanel) => detailsPanel.checkVisibility({ visibilityProperty: true }),
                ),
              };
              for (const slot of ["conversation", "dashboard", "workspace"]) {
                for (const region of ["main", "side"]) {
                  facts[`detailsViewAll_${slot}_${region}`] = panels.filter(
                    (panel) => panel.dataset.panelSlot === slot && panel.dataset.region === region,
                  ).length;
                }
              }
              return facts;
            }),
            1_000,
          )
            .then((facts) => recordControlUiE2eFailureFacts(page, facts))
            .catch(() => undefined);
          throw error;
        }
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
