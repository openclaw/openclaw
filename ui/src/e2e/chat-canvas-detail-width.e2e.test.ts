import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { buildBoardWidgetContentSecurityPolicy } from "../../../src/gateway/board-sandbox.js";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
  it("fills the Canvas reader through expand and shrink without changing its frame contract", async () => {
    const sessionKey = "agent:main:canvas-reader";
    const docId = "canvas-reader-checklist";
    const entryUrl = "/__openclaw__/canvas/documents/" + docId + "/index.html";
    const rawText = JSON.stringify({
      kind: "canvas",
      view: { id: docId, url: entryUrl },
      presentation: {
        target: "assistant_message",
        title: "Reader layout checklist",
        sandbox: "scripts",
        preferredHeight: 320,
      },
    });
    const html = buildWidgetDocument(
      "Reader layout checklist",
      '<main style="padding:22px"><h2>Reader layout checklist</h2><p>All content is synthetic. This is the canonical isolated Canvas document.</p><ol><li>Keep the title and actions readable.</li><li>Allow long content to wrap inside the reader.</li><li>Retain the real sandbox and host theme.</li></ol><button>Review checklist</button><output style="display:block;margin-top:12px">Ready for review</output></main>',
    );
    const history = prepareChatHistoryFixture([
      { role: "user", content: "Inspect a saved synthetic Canvas document." },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "canvas-proof",
            name: "show_widget",
            arguments: { title: "Reader layout checklist", html: "Synthetic stored document" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "canvas-proof",
        toolName: "show_widget",
        content: [{ type: "text", text: rawText }],
      },
      { role: "assistant", content: "The checklist is ready for review." },
    ]);
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        viewport: { width: 820, height: 900 },
        colorScheme: "light",
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey,
          communityInvite: false,
          historyMessages: history.messages,
          featureMethods: [...defaultControlUiFeatureMethods, "canvas.document.view"],
          methodResponses: { "chat.history": history, "canvas.document.view": canvasView(html) },
        });
        await page.route("**" + entryUrl, (route) =>
          route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: html,
            headers: {
              "content-security-policy": buildBoardWidgetContentSecurityPolicy({
                grantState: "none",
                resourceOrigins: ["'self'"],
              }),
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
            },
          }),
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        for (const group of await page
          .locator('.chat-activity-group__summary[aria-expanded="false"]')
          .all()) {
          await group.click();
        }
        await page.locator(".chat-tool-msg-summary").first().click();
        await page
          .locator(".chat-thread openclaw-canvas-widget-view iframe")
          .first()
          .contentFrame()
          .frameLocator("iframe")
          .getByRole("heading", { name: "Reader layout checklist" })
          .waitFor();
        await page
          .getByRole("button", { name: "Open tool details in side panel", exact: true })
          .click();
        const panel = page.locator("openclaw-chat-detail-panel").filter({ visible: true }).first();
        const frame = panel.locator("iframe.chat-tool-card__preview-frame");
        const heading = frame
          .contentFrame()
          .getByRole("heading", { name: "Reader layout checklist", exact: true });
        await heading.waitFor();
        const original = await frame.elementHandle();
        const measure = () =>
          panel.evaluate((element) => {
            const iframe = element.querySelector("iframe");
            if (!iframe) {
              throw new Error("Canvas frame missing");
            }
            return {
              panel: element.getBoundingClientRect().width,
              frame: iframe.getBoundingClientRect().width,
              height: iframe.getBoundingClientRect().height,
            };
          });
        for (const expanded of [false, true, false]) {
          if (expanded) {
            await page
              .locator(".chat-mobile-host__header")
              .getByRole("button", { name: "Expand Side panel", exact: true })
              .click();
          } else if (
            await page
              .locator(".chat-mobile-host__header")
              .getByRole("button", { name: "Restore", exact: true })
              .isVisible()
          ) {
            await page
              .locator(".chat-mobile-host__header")
              .getByRole("button", { name: "Restore", exact: true })
              .click();
          }
          const screenshot = await takeControlUiScreenshotFrame(page, panel, [heading], {
            animations: "disabled",
          });
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await writeFile(
              path.join(suite.artifactDir, expanded ? "canvas-expanded.png" : "canvas-reader.png"),
              screenshot.png,
            );
          }
          const geometry = await measure();
          console.log("Canvas reader geometry", geometry, "expanded", expanded);
          expect.soft(geometry.panel - geometry.frame).toBeLessThanOrEqual(34);
          expect(geometry.height).toBe(420);
          expect(await frame.evaluate((element) => element.style.height)).toBe("320px");
          expect(await frame.evaluate((element, previous) => element === previous, original)).toBe(
            true,
          );
        }
        for (const viewport of [
          { width: 1400, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          await page.emulateMedia({ colorScheme: "dark" });
          await heading.waitFor();
          await expect
            .poll(async () => {
              const geometry = await measure();
              return geometry.panel - geometry.frame;
            })
            .toBeLessThanOrEqual(34);
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const screenshot = await takeControlUiScreenshotFrame(page, panel, [heading], {
              animations: "disabled",
            });
            await writeFile(
              path.join(suite.artifactDir, "canvas-" + viewport.width + ".png"),
              screenshot.png,
            );
          }
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
        }
        expect(await frame.getAttribute("sandbox")).toBe("allow-scripts");
        expect(new URL((await frame.getAttribute("src"))!, suite.server.baseUrl).pathname).toBe(
          entryUrl,
        );
        const rawButton = panel.getByRole("button", { name: "View raw text", exact: true });
        await rawButton.focus();
        expect(await rawButton.evaluate((element) => element === document.activeElement)).toBe(
          true,
        );
        expect(
          await panel.locator(".sidebar-content").evaluate((element) => element.scrollTop),
        ).toBeGreaterThan(0);
        await rawButton.press("Enter");
        await expect
          .poll(() => panel.locator(".sidebar-markdown-reader").textContent())
          .toContain(rawText);
        expect(await panel.locator("iframe").count()).toBe(0);
        expect(await gateway.getRequests("canvas.document.view")).toHaveLength(1);
      },
    );
  });
});
