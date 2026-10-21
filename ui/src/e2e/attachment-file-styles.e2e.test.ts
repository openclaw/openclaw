import { expect, it } from "vitest";
import { createPlaybackMediaFixture } from "../../../test/fixtures/media-playback.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { computedStyles as styles } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectStyles } from "./style-contract.test-support.ts";

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
                attachment: { code: "file-not-found", kind: "document", label: "missing.pdf" },
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
        await expectStyles(large, {
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
        await expectStyles(compact, {
          width: "20px",
          height: "20px",
          "background-image": expect.stringContaining(`compact/${theme}/mp3.svg`),
        });
        await expectStyles(documentCard, { display: "block", padding: "0px" });
        const danger = await unavailable.evaluate((card) => {
          const sample = document.createElement("span");
          sample.style.color = getComputedStyle(card).getPropertyValue("--danger").trim();
          document.body.append(sample);
          const resolved = getComputedStyle(sample).color;
          sample.remove();
          return resolved;
        });
        await expectStyles(unavailable, { color: danger, display: "block", padding: "0px" });
        await expectStyles(unavailable.locator(".chat-attachment-file-icon"), {
          color: danger,
          opacity: "0.42",
        });
        await expectStyles(unavailable.locator(".chat-assistant-attachment-card__status-meta"), {
          color: danger,
        });
        await expectStyles(unavailable.locator(".chat-assistant-attachment-card__title"), {
          "text-decoration-line": "line-through",
          "text-decoration-thickness": "1px",
        });
      }
    });
  });
});
