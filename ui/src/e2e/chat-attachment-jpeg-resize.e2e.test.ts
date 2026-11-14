import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Oversized JPEG composer resize" });

// Real 1024x768 JPEG with EXIF orientation 6 (portrait camera photo), 348 KiB.
const fixture = readFileSync(new URL("./fixtures/oriented-portrait-photo.jpg", import.meta.url));
const limit = 200 * 1024;

suite.define(() => {
  it("prepares an oversized EXIF portrait JPEG within the advertised limit and sends it upright", () =>
    suite.withPage(
      {
        // The composer's English labels are asserted below; pin the locale
        // so the suite passes on hosts whose system language is not English.
        ...createControlUiE2eContextOptions(),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, { attachmentMaxBytes: limit });
        await page.goto(suite.server.baseUrl + "chat");
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Resize this portrait camera photo.");
        await page.locator(".agent-chat__file-input").first().setInputFiles({
          name: "portrait-photo.jpg",
          mimeType: "image/jpeg",
          buffer: fixture,
        });

        // Admitted for preparation rather than rejected: one ready thumbnail,
        // no "File too large" toast, and no failure chip beside the composer.
        await expect
          .poll(() => page.locator('.chat-attachment-thumb[aria-busy="false"]').count())
          .toBe(1);
        expect(await page.locator(".app-toast").count()).toBe(0);
        expect(await page.locator(".chat-attachment-failures").count()).toBe(0);

        const artifactDir = path.join(suite.artifactDir, "jpeg-resize");
        await mkdir(artifactDir, { recursive: true });
        await page.screenshot({ path: path.join(artifactDir, "prepared-composer.png") });

        // The send action stays gated on the initial chat history committing;
        // wait for it to become actionable before submitting the attachment.
        const send = page.getByRole("button", { name: "Send message", exact: true });
        await expect.poll(() => send.isEnabled()).toBe(true);
        await send.click();
        const request = await gateway.waitForRequest("chat.send");
        const params = request.params as {
          attachments: Array<{ content: string; mimeType: string; fileName: string }>;
        };
        const photo = params.attachments.find(
          (attachment) => attachment.fileName === "portrait-photo.jpg",
        );
        expect(photo).toBeTruthy();
        expect(photo!.mimeType).toBe("image/jpeg");
        const bytes = Buffer.from(photo!.content, "base64");
        expect(bytes.length).toBeGreaterThan(0);
        expect(bytes.length).toBeLessThanOrEqual(limit);

        // Decode the actual sent payload in the browser: the prepared JPEG
        // must be portrait (upright), not the sideways 1024x768 raw frame.
        const portrait = await page.evaluate(async (content) => {
          const decoded = Uint8Array.from(atob(content), (char) => char.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([decoded], { type: "image/jpeg" }));
          try {
            return { width: bitmap.width, height: bitmap.height };
          } finally {
            bitmap.close();
          }
        }, photo!.content);
        expect(portrait.height).toBeGreaterThan(portrait.width);

        await expect
          .poll(() => page.locator(".chat-group.user .chat-image-frame").count())
          .toBeGreaterThan(0);
        await page.screenshot({ path: path.join(artifactDir, "sent-upright.png") });
        await writeFile(
          path.join(artifactDir, "diagnostics.json"),
          JSON.stringify(
            {
              limitBytes: limit,
              fixtureBytes: fixture.length,
              sentBytes: bytes.length,
              sentMimeType: photo!.mimeType,
              sentDimensions: portrait,
              fileName: "portrait-photo.jpg",
            },
            null,
            2,
          ),
        );
      },
    ));
});
