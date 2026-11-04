import path from "node:path";
import { expect, it } from "vitest";
import { mediaTicketPayload } from "../test-helpers/control-ui-attachment-fixtures.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { readControlUiE2eDownload } from "../test-helpers/control-ui-e2e-download.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Original SVG downloads" });

suite.define(() => {
  it.each([false, true])(
    "downloads original SVG bytes with restored history: %s",
    async (restored) => {
      const proof =
        process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
          ? createControlUiE2eArtifactDir("svg-download")
          : undefined;
      await suite.withPage(
        {
          viewport: { width: 1440, height: 900 },
          ...(proof ? { recordVideo: { dir: proof, size: { width: 1440, height: 900 } } } : {}),
        },
        async ({ page }) => {
          const filename = "parcel flow.svg";
          const source = "/workspace/parcel flow.svg";
          const bytes = Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="660" height="120"><rect width="660" height="120" fill="#204858"/><text x="32" y="68" fill="white" font-size="30">Parcel flow → ready</text><script>window.svgExecuted=true</script></svg>\r\n',
          );
          await page.route("**/__openclaw__/assistant-media?**", async (route) => {
            const url = new URL(route.request().url());
            expect(url.searchParams.get("source")).toBe(source);
            await route.fulfill(
              url.searchParams.get("meta") === "1"
                ? { json: mediaTicketPayload("svg-proof") }
                : { contentType: "image/svg+xml", body: bytes },
            );
          });
          const reply = {
            role: "assistant",
            timestamp: Date.now(),
            __openclaw: { id: "svg-reply", seq: 1 },
            content: [
              {
                type: "attachment",
                attachment: {
                  kind: "image",
                  label: filename,
                  mimeType: "image/svg+xml",
                  url: source,
                  sizeBytes: bytes.length,
                },
              },
            ],
          };
          const gateway = await installMockGateway(page, {
            historyMessages: restored ? [reply] : [],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await gateway.waitForRequest("sessions.messages.subscribe");
          if (!restored) {
            await gateway.setHistoryMessages([reply]);
            await gateway.emitGatewayEvent("session.message", {
              message: reply,
              sessionKey: "agent:main:main",
              messageId: "svg-reply",
              messageSeq: 1,
              activeRunIds: [],
              hasActiveRun: false,
            });
          } else {
            await page.reload();
          }
          await page.getByRole("button", { name: `Open image ${filename}`, exact: true }).click();
          const lightbox = page.locator("openclaw-image-lightbox");
          await lightbox.getByRole("dialog").waitFor();
          await expect
            .poll(() =>
              lightbox
                .locator("img")
                .evaluate((node) =>
                  node instanceof HTMLImageElement && node.complete ? node.naturalWidth : 0,
                ),
            )
            .toBe(660);
          const outcome = Promise.race([
            page.waitForEvent("download"),
            page
              .getByText("Could not download this image. Try again.", { exact: true })
              .waitFor()
              .then(() => null),
          ]);
          await lightbox.getByRole("button", { name: "Download image", exact: true }).click();
          const download = await outcome;
          if (proof) {
            await page.screenshot({
              path: path.join(proof, restored ? "restored.png" : "initial.png"),
            });
          }
          expect(
            download,
            "The visible SVG download action must save its original file",
          ).not.toBeNull();
          expect(download!.suggestedFilename()).toBe(filename);
          expect(await readControlUiE2eDownload(download!)).toEqual(bytes);
          expect(await page.evaluate(() => "svgExecuted" in window)).toBe(false);
          expect(page.context().pages()).toHaveLength(1);
          await page.keyboard.press("Escape");
        },
        async ({ page, context }) => {
          const video = page.video();
          await suite.closeBrowserContext(context);
          if (proof) {
            await video?.saveAs(path.join(proof, restored ? "history.webm" : "incoming.webm"));
          }
        },
      );
    },
  );
});
