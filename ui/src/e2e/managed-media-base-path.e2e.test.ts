import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { chatMessage, installMockGateway, textContent } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI managed media under a UI base path",
  startServerBeforeBrowser: true,
});
const proofDirParent = process.env.OPENCLAW_MEDIA_PROOF_DIR?.trim() || null;
suite.define(() => {
  it("loads managed-media APIs beneath the configured UI base path", async () => {
    const proofDir = proofDirParent
      ? createControlUiE2eArtifactDir("managed-media-base-path", proofDirParent)
      : undefined;
    const viewport = { width: 1280, height: 800 };
    await suite.withPage(
      {
        ...(proofDir ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
        serviceWorkers: "block",
        viewport,
      },
      async ({ page }) => {
        const sourcePath =
          "/api/chat/media/outgoing/agent%3Amain%3Amain/00000000-0000-4000-8000-000000000001/full";
        const previewPath = `/rosita${sourcePath.replace(/\/full$/u, "/thumbnail")}`;
        const imageBytes = await readFile(
          path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"),
        );
        const requests: Array<{ contentType: string; path: string }> = [];

        await page.route("**/rosita/api/chat/media/outgoing/**", async (route) => {
          const requestPath = new URL(route.request().url()).pathname;
          const preview = requestPath === previewPath;
          const contentType = preview ? "image/png" : "text/html";
          requests.push({ contentType, path: requestPath });
          await route.fulfill({
            body: preview ? imageBytes : "<!doctype html><title>OpenClaw</title>",
            contentType,
            status: 200,
          });
        });

        const gateway = await installMockGateway(page, {
          basePath: "/rosita",
          historyMessages: [
            {
              role: "assistant",
              content: [
                ...textContent("Managed attachment proof"),
                { type: "image", url: sourcePath, alt: "Managed proof image" },
              ],
              timestamp: 1,
            },
            chatMessage("assistant", "Distinct second reply", { timestamp: 2 }),
          ],
        });

        await page.goto(`${suite.server.baseUrl}rosita/chat`);
        await gateway.waitForRequest("chat.startup");
        const image = page.getByAltText("Managed proof image");
        await image.waitFor({ state: "attached", timeout: 10_000 });
        await expect.poll(() => requests.length).toBeGreaterThan(0);
        if (proofDir) {
          await writeFile(
            path.join(proofDir, "state.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [image]),
          );
        }

        const naturalWidth = await image.evaluate((node) =>
          node instanceof HTMLImageElement ? node.naturalWidth : 0,
        );
        expect(requests).toEqual([{ contentType: "image/png", path: previewPath }]);
        expect(naturalWidth).toBeGreaterThan(0);
        expect(await page.getByText("Managed attachment proof", { exact: true }).count()).toBe(1);
        expect(await page.getByText("Distinct second reply", { exact: true }).count()).toBe(1);
      },
    );
  });
});
