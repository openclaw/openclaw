import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { BoardReport } from "../../../src/boards/board-report.ts";
import { createBoardWidget } from "../lib/board/widget.test-support.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const suite = createControlUiE2eSuite({
  name: "Control UI native report dashboard widget",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:community-report";

function reportSnapshot(detailsUrl: string, revision = 1) {
  const props: BoardReport = {
    blocks: [
      {
        type: "text",
        text: revision === 1 ? "A welcoming week" : "Updated after the afternoon review",
      },
      {
        type: "links",
        items: [{ label: "Details", url: detailsUrl }],
      },
    ],
  };
  return {
    sessionKey,
    revision,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: [
      createBoardWidget({
        name: "community-report",
        title: "Weekly community report",
        contentKind: "plugin",
        pluginKind: "session:report",
        props,
        sizeW: 12,
        sizeH: 20,
        revision,
      }),
    ],
  };
}
async function assertNativeDocument(page: Page, documents: string[], dashboardUrl: string) {
  expect(await page.locator("iframe").count()).toBe(0);
  expect(page.frames()).toHaveLength(1);
  expect(documents).toEqual([dashboardUrl]);
}

suite.define(() => {
  it.each([
    { height: 900, name: "desktop", width: 1440 },
    { height: 844, name: "mobile", width: 390 },
  ])("renders and refreshes a native report without a document on $name", async (viewport) => {
    await suite.withPage(
      {
        viewport,
        ...(captureUiProof ? { recordVideo: { dir: suite.artifactDir, size: viewport } } : {}),
      },
      async ({ context, page }) => {
        const detailsUrl = new URL("/native-report-details", suite.server.baseUrl).href;
        const documents: string[] = [];
        context.on("request", (request) => {
          if (request.resourceType() === "document") {
            documents.push(request.url());
          }
        });
        await context.route(detailsUrl, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<h1>Weekly report details</h1>",
          }),
        );
        const gateway = await installMockGateway(page, {
          sessionKey,
          controlUiWidgetKinds: [{ pluginId: "session", kind: "session:report", label: "Report" }],
          featureMethods: [
            "board.get",
            "chat.metadata",
            "chat.startup",
            "sessions.list",
            "sessions.patch",
          ],
          methodResponses: {
            "board.get": reportSnapshot(detailsUrl),
            "sessions.list": chatSessionListResponse([
              { key: sessionKey, kind: "direct", label: "Community report", updatedAt: Date.now() },
            ]),
          },
        });
        await page.addInitScript(
          ({ key, storage }) => {
            localStorage.setItem(
              storage,
              JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
            );
          },
          { key: sessionKey, storage: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
        );

        const dashboardUrl = controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard");
        await page.goto(dashboardUrl);
        const report = page.locator("openclaw-report-widget");
        await report.waitFor();
        await expect.poll(() => report.textContent()).toContain("A welcoming week");
        const details = report.getByRole("link", { name: "Details", exact: true });
        expect(await details.getAttribute("href")).toBe(detailsUrl);
        await assertNativeDocument(page, documents, dashboardUrl);
        const screenshot = async (name: string) => {
          if (captureUiProof) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(suite.artifactDir, `${name}-${viewport.name}.png`),
            });
          }
        };
        await screenshot("report");

        const originalReport = await report.evaluateHandle((element) => element);
        const reads = (await gateway.getRequests("board.get")).length;
        await gateway.setMethodResponse("board.get", reportSnapshot(detailsUrl, 2));
        await gateway.emitGatewayEvent("board.changed", {
          sessionKey,
          revision: 2,
          widget: "community-report",
        });
        await gateway.waitForRequest("board.get", { after: reads });
        await expect
          .poll(() => report.textContent())
          .toContain("Updated after the afternoon review");
        expect(
          await originalReport.evaluate(
            (element) =>
              element.isConnected && element === document.querySelector("openclaw-report-widget"),
          ),
        ).toBe(true);
        await originalReport.dispose();
        await assertNativeDocument(page, documents, dashboardUrl);
        await report.scrollIntoViewIfNeeded();
        await screenshot("report-updated");

        const opened = context.waitForEvent("page");
        await details.click();
        const detailsPage = await opened;
        await detailsPage.getByRole("heading", { name: "Weekly report details" }).waitFor();
        expect(detailsPage.url()).toBe(detailsUrl);
        expect(await detailsPage.evaluate(() => window.opener === null)).toBe(true);
        expect(documents).toEqual([dashboardUrl, detailsUrl]);
        expect(page.url()).toBe(dashboardUrl);
      },
    );
  });

  // The default "md" pin size (6 columns by 4 rows) for a report that stacks taller than that.
  async function openBlockersReport(page: Page) {
    const rows = Array.from({ length: 8 }, (_, index) => [`Issue ${index + 1}`, "Open", "Mira"]);
    await installMockGateway(page, {
      sessionKey,
      controlUiWidgetKinds: [{ pluginId: "session", kind: "session:report", label: "Report" }],
      featureMethods: ["board.get", "chat.metadata", "chat.startup", "sessions.list"],
      methodResponses: {
        "board.get": {
          ...reportSnapshot("https://example.com/"),
          widgets: [
            createBoardWidget({
              name: "blockers",
              title: "Blockers",
              contentKind: "plugin",
              pluginKind: "session:report",
              props: { blocks: [{ type: "table", columns: ["Issue", "Status", "Owner"], rows }] },
            }),
          ],
        },
        "sessions.list": chatSessionListResponse([
          { key: sessionKey, kind: "direct", label: "Release", updatedAt: Date.now() },
        ]),
      },
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
    const board = page.locator("openclaw-board-view");
    const body = board.locator('[data-widget-name="blockers"] .board-widget__body');
    await body.getByText("Issue 8").waitFor({ state: "attached" });
    return { board, body };
  }

  it("shows a whole saved-size report on a phone so a swipe over it scrolls the board", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      async ({ context, page }) => {
        const { board, body } = await openBlockersReport(page);
        // Before the fix the report kept its 260px desktop height and scrolled inside itself.
        expect(await body.evaluate((node) => node.scrollHeight - node.clientHeight)).toBe(0);

        const box = (await body.boundingBox())!;
        const x = box.x + box.width / 2;
        const y = Math.min(box.y + box.height, 800) - 20;
        const cdp = await context.newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: y - 200 }],
        });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect.poll(() => board.evaluate((node) => node.scrollTop)).toBeGreaterThan(100);
      },
    );
  });

  it("keeps a report at its saved size in the narrow desktop panel", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const { board, body } = await openBlockersReport(page);
      // The docked panel stacks cards like a phone, but on desktop the user's size wins.
      expect(await board.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThan(560);
      expect(await body.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(
        0,
      );
    });
  });
});
