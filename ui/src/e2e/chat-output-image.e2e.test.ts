import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { chatMessage } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Outputs image preview" });

suite.define(() => {
  it("opens a managed output as an image and downloads its original bytes", async () => {
    const proof =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? createControlUiE2eArtifactDir("output-image")
        : undefined;
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const sessionKey = "agent:main:output-image";
      const artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111";
      const title = "project-preview.png";
      const artifact = {
        id: artifactId,
        type: "image",
        title,
        mimeType: "image/png",
        download: { mode: "url" },
      };
      const imageUrl = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/11111111-1111-4111-8111-111111111111/full`;
      const bytes = await readFile(
        path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"),
      );
      const pendingArtifact = {
        ...artifact,
        id: `${artifactId}-pending`,
        title: "pending-preview.png",
      };
      const pendingImage = Promise.withResolvers<void>();
      await page.route("**/api/chat/media/outgoing/**", async (route) => {
        if (route.request().url().includes("/pending/full")) {
          await pendingImage.promise;
        }
        expect(new URL(route.request().url()).searchParams.get("mediaTicket")).toBe("proof-ticket");
        await route.fulfill({ body: bytes, contentType: "image/png" });
      });
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages: [chatMessage("assistant", "The project preview is ready in Outputs.")],
        methodResponses: {
          "artifacts.list": { artifacts: [artifact, pendingArtifact] },
          "artifacts.download": {
            artifact,
            url: `${imageUrl}?mediaTicket=proof-ticket`,
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
          "board.get": { sessionKey, tabs: [], widgets: [] },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const details = await openChatDetails(page);
      const group = details.locator('[data-details-group="outputs"]');
      const row = group.getByRole("button", { name: title, exact: true });
      if (!(await row.isVisible())) {
        await group.locator(":scope > summary").click();
      }
      const openedAt = await page.evaluate(() => performance.now());
      await row.click();
      await page
        .locator(".sidebar-image-view, .sidebar-markdown-shell")
        .filter({ visible: true })
        .first()
        .waitFor();
      const image = page.locator(".sidebar-image-view img");
      if (await image.count()) {
        await expect
          .poll(() =>
            image.evaluate((node) =>
              node instanceof HTMLImageElement && node.complete ? node.naturalWidth : 0,
            ),
          )
          .toBe(1280);
      }
      if (proof) {
        console.info(
          "Output image opening",
          await page.evaluate(
            (start) => ({
              elapsedMs: performance.now() - start,
              image: Boolean(document.querySelector(".sidebar-image-view img")),
              resources: performance
                .getEntriesByType("resource")
                .filter((entry) => entry.startTime >= start)
                .map((entry) => ({
                  name: new URL(entry.name).pathname,
                  durationMs: entry.duration,
                })),
            }),
            openedAt,
          ),
        );
        await page.screenshot({ path: path.join(proof, "output-preview.png") });
      }
      expect(await image.count()).toBe(1);
      await expect
        .poll(() =>
          image.evaluate((node) =>
            node instanceof HTMLImageElement && node.complete ? node.naturalWidth : 0,
          ),
        )
        .toBe(1280);
      const panel = page.locator(".sidebar-image-view");
      const download = page.waitForEvent("download");
      await panel.getByRole("button", { name: "Download file", exact: true }).click();
      const saved = await download;
      expect(saved.suggestedFilename()).toBe(title);
      expect(await readFile((await saved.path())!)).toEqual(bytes);
      await panel
        .getByRole("button", { name: `Open image ${title}`, exact: true })
        .first()
        .click();
      await page.getByRole("dialog", { name: `Image preview: ${title}` }).waitFor();
      expect(await gateway.getRequests("artifacts.download")).toHaveLength(2);
      await page.keyboard.press("Escape");
      await gateway.setMethodResponse("artifacts.download", {
        __mockError: { code: "FORBIDDEN", message: "Image access revoked" },
      });
      const unexpectedDownloads: string[] = [];
      page.on("download", (file) => unexpectedDownloads.push(file.suggestedFilename()));
      await panel.getByRole("button", { name: "Download file", exact: true }).click();
      await page.getByText(/Image access revoked/).waitFor();
      expect(unexpectedDownloads).toEqual([]);
      expect(await gateway.getRequests("artifacts.download")).toHaveLength(3);
      await gateway.setMethodResponse("artifacts.download", {
        artifact: pendingArtifact,
        url: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/pending/full?mediaTicket=proof-ticket`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      const pendingRequest = page.waitForRequest((request) =>
        request.url().includes("/pending/full"),
      );
      const abortedRequest = page.waitForEvent("requestfailed", {
        predicate: (request) => request.url().includes("/pending/full"),
      });
      try {
        const outputs = await openChatDetails(page);
        await outputs.getByRole("button", { name: pendingArtifact.title, exact: true }).click();
        await pendingRequest;
        await page.getByRole("button", { name: `Close tab: ${title}`, exact: true }).click();
        expect((await abortedRequest).failure()?.errorText).toContain("ERR_ABORTED");
      } finally {
        pendingImage.resolve();
      }
      expect(await page.locator(".sidebar-image-view").count()).toBe(0);
      expect(
        await page
          .getByRole("button", { name: `Close tab: ${pendingArtifact.title}`, exact: true })
          .count(),
      ).toBe(0);
    });
  });
});
