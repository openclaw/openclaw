import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { pdfFixture } from "../test-helpers/pdf-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "PDF comments" });

suite.define(() => {
  it.each(["scanned", "invalid"])(
    "offers an honest PDF outcome for a %s document",
    async (kind) => {
      await suite.withPage(
        { viewport: { width: 390, height: 844 }, colorScheme: "dark" },
        async ({ page }) => {
          const url = "/__openclaw__/assistant-media?mediaTicket=pdf-fallback-fixture";
          await page.route("**/__openclaw__/assistant-media?**", (route) =>
            route.fulfill({
              contentType: "application/pdf",
              body:
                kind === "invalid" ? Buffer.from("not a PDF") : Buffer.from(pdfFixture(["", ""])),
            }),
          );
          await installMockGateway(page, {
            historyMessages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "attachment",
                    attachment: {
                      kind: "document",
                      label: "brief.pdf",
                      mimeType: "application/pdf",
                      url,
                    },
                  },
                ],
              },
            ],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.locator(".chat-assistant-attachment-card__expand").click();
          await page
            .getByText(
              kind === "invalid"
                ? "This PDF could not be displayed. Open the original to view or unlock it."
                : "This page has no selectable text. Scanned pages need OCR before you can comment on text.",
              { exact: true },
            )
            .waitFor();
          const original = page.getByRole("link", { name: "Open original PDF", exact: true });
          expect(await original.getAttribute("href")).toMatch(/^blob:/);
          expect(await page.getByRole("button", { name: "Add to chat", exact: true }).count()).toBe(
            0,
          );
        },
      );
    },
  );
  it("sends a PDF text comment with the document name and selected page", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const url = "/__openclaw__/assistant-media?mediaTicket=pdf-comment-fixture";
        await page.route("**/__openclaw__/assistant-media?**", (route) =>
          route.fulfill({ contentType: "application/pdf", body: Buffer.from(pdfFixture()) }),
        );
        const gateway = await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "Review the release checklist." },
                {
                  type: "attachment",
                  attachment: {
                    kind: "document",
                    label: "release-checklist.pdf",
                    mimeType: "application/pdf",
                    url,
                  },
                },
              ],
            },
          ],
        });
        await page.route(`${suite.server.baseUrl}chat`, async (route) => {
          const response = await route.fetch();
          const body = await response.text();
          await route.fulfill({
            response,
            body,
            headers: {
              ...response.headers(),
              "content-security-policy": buildControlUiCspHeader({
                inlineScriptHashes: computeInlineScriptHashes(body),
              }),
            },
          });
        });
        const worker = page.waitForEvent("worker", {
          predicate: (value) => value.url().endsWith("/pdf.worker.min.js"),
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const card = page
          .locator(".chat-assistant-attachment-card--compact")
          .filter({ hasText: "release-checklist.pdf" });
        await card.locator(".chat-assistant-attachment-card__expand").click();
        const surface = page.locator(".sidebar-pdf-preview");
        if (process.env.OPENCLAW_PDF_COMMENT_CAPTURE === "before") {
          await surface.locator("iframe").waitFor();
          const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
            animations: "disabled",
          });
          await writeFile(`${suite.artifactDir}/pdf-before.png`, frame.png);
        }
        await worker;
        await page.getByRole("button", { name: "Next page", exact: true }).click();
        const text = surface
          .locator(".textLayer span")
          .filter({ hasText: "Confirm the rollback owner." });
        await text.waitFor();
        await text.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        });
        await text.dispatchEvent("pointerup", { button: 0, pointerType: "mouse" });
        await page.getByRole("button", { name: "Add to chat", exact: true }).click();
        const editor = page.getByRole("dialog", { name: "Comment", exact: true });
        await editor.getByRole("textbox").fill("Name the on-call owner here.");
        if (process.env.OPENCLAW_PDF_COMMENT_CAPTURE === "after") {
          const frame = await takeControlUiScreenshotFrame(page, surface, [text, editor], {
            animations: "disabled",
          });
          await writeFile(`${suite.artifactDir}/pdf-after.png`, frame.png);
        }
        await editor.getByRole("textbox").press("Enter");
        await page.locator(".chat-selection-annotations__chip").hover();
        await page.getByText("release-checklist.pdf · Page 2", { exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        // SAFETY: the mock captures the production composer's chat.send request.
        const params = request.params as { attachments: Array<{ content: string }> };
        const payload = Buffer.from(params.attachments[0]!.content, "base64").toString("utf8");
        expect(payload).toContain("Confirm the rollback owner.");
        expect(payload).toContain("Name the on-call owner here.");
        expect(payload).toContain('Source PDF: "release-checklist.pdf"');
        expect(payload).toContain("Source page: 2");
      },
    );
  });
});
