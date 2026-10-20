import { expect, it } from "vitest";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { computedStyles as styles } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Attachment file styles" });

function attachment(kind: string, label: string, mimeType: string) {
  return {
    type: "attachment",
    attachment: { kind, label, mimeType, url: new URL(label, suite.server.baseUrl).href },
  };
}

suite.define(() => {
  it("preserves large, preview, and unavailable file visuals in both themes", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await page.route("**/style-proof.mp3", (route) =>
        route.fulfill({ contentType: "audio/mpeg", body: createPlaybackMediaFixture("mp3") }),
      );
      await installMockGateway(page, {
        historyMessages: [
          {
            role: "assistant",
            content: [
              attachment("document", "report.pdf", "application/pdf"),
              attachment("audio", "style-proof.mp3", "audio/mpeg"),
              {
                type: "attachment_error",
                attachment: {
                  code: "file-not-found",
                  kind: "document",
                  label: "missing.pdf",
                },
              },
            ],
            timestamp: 1,
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const compact = page.locator('.chat-attachment-file-icon[data-mode="preview-with-favicon"]');
      await compact.waitFor({ state: "visible" });
      const documentCard = page.locator(".chat-assistant-attachment-card--compact", {
        hasText: "report.pdf",
      });
      const unavailable = page.locator(".chat-assistant-attachment-card--definitive", {
        hasText: "missing.pdf",
      });
      await unavailable.waitFor({ state: "visible" });

      for (const theme of ["dark", "light"]) {
        await page.evaluate((mode) => {
          document.documentElement.dataset.themeMode = mode;
        }, theme);
        const large = documentCard.locator(".chat-attachment-file-icon");
        expect(await styles(large, ["width", "height", "background-image"])).toEqual({
          width: "44px",
          height: "44px",
          "background-image": expect.stringContaining(`large/shell-${theme}.svg`),
        });
        const glyph = await styles(large.locator(".chat-attachment-file-icon__overlay"), [
          "width",
          "height",
          "mask-image",
          "-webkit-mask-image",
        ]);
        expect(glyph).toEqual({
          width: "14px",
          height: "14px",
          "mask-image": expect.stringContaining("overlays/pdf.svg"),
          "-webkit-mask-image": glyph["mask-image"],
        });
        expect(await styles(compact, ["width", "height", "background-image"])).toEqual({
          width: "20px",
          height: "20px",
          "background-image": expect.stringContaining(`compact/${theme}/mp3.svg`),
        });
        expect(await styles(documentCard, ["display", "padding"])).toEqual({
          display: "block",
          padding: "0px",
        });
        const failedStyle = await unavailable.evaluate((card) => {
          const icon = card.querySelector(".chat-attachment-file-icon")!;
          const metadata = card.querySelector(".chat-assistant-attachment-card__status-meta")!;
          const title = card.querySelector(".chat-assistant-attachment-card__title")!;
          return {
            color: getComputedStyle(card).color,
            danger: getComputedStyle(card).getPropertyValue("--danger").trim(),
            iconColor: getComputedStyle(icon).color,
            statusColor: getComputedStyle(metadata).color,
            opacity: getComputedStyle(icon).opacity,
            decoration: getComputedStyle(title).textDecorationLine,
            thickness: getComputedStyle(title).textDecorationThickness,
            display: getComputedStyle(card).display,
            padding: getComputedStyle(card).padding,
          };
        });
        expect(failedStyle).toMatchObject({
          iconColor: failedStyle.color,
          statusColor: failedStyle.color,
          opacity: "0.42",
          decoration: "line-through",
          thickness: "1px",
          display: "block",
          padding: "0px",
        });
        expect(failedStyle.color).toBe(
          await page.evaluate((color) => {
            const sample = document.createElement("span");
            sample.style.color = color;
            document.body.append(sample);
            const resolved = getComputedStyle(sample).color;
            sample.remove();
            return resolved;
          }, failedStyle.danger),
        );
      }
    });
  });
});
