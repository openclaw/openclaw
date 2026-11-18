import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { openChatPanels } from "../test-helpers/chat-layout-menu.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { readerUrl as url, withLinkReader } from "./link-reader.test-support.ts";

it("keeps the retained title readable through refresh failure and retry at every pane width", async () => {
  const overview: ControlUiLinkReaderDocument = {
    url,
    title: "Keep loaded reader controls reachable in constrained panes",
    body: "Readable retained details.\n\n".repeat(40),
  };
  const artifacts = createControlUiE2eArtifactDir(
    "link-reader-refresh",
    path.resolve(".openclaw/tmp"),
  );
  const overlaps: number[] = [];
  await withLinkReader(
    { methodResponses: { "forge.detail": overview } },
    async ({ page, gateway, panel, content }) => {
      const refresh = panel
        .locator(".lr-toolbar")
        .getByRole("button", { name: "Refresh item", exact: true });
      const heading = panel.getByRole("heading", { name: overview.title, exact: true });
      await heading.waitFor();
      const retainedDocument = await panel.locator(".lr-document").elementHandle();
      for (const width of [1400, 820, 390]) {
        await page.setViewportSize({ width, height: 844 });
        if (width <= 820) {
          await openChatPanels(page, "mobile");
        }
        await takeControlUiScreenshotFrame(page, panel, [heading], { animations: "disabled" });
        const before = await heading.boundingBox();
        const after = await gateway.deferNext("forge.detail");
        await refresh.click();
        expect((await gateway.waitForRequest("forge.detail", { after })).params).toMatchObject({
          url,
          refresh: true,
        });
        expect(await refresh.isDisabled()).toBe(true);
        for (const state of ["pending", "failed"] as const) {
          if (state === "failed") {
            await gateway.rejectDeferred("forge.detail", {
              code: "UNAVAILABLE",
              message: "Refresh unavailable. Try again.",
              retryable: true,
            });
            await expect.poll(() => refresh.isEnabled()).toBe(true);
          }
          const frame = await takeControlUiScreenshotFrame(page, panel, [heading], {
            animations: "disabled",
          });
          writeFileSync(path.join(artifacts, width + "-" + state + ".png"), frame.png);
          expect(await heading.boundingBox()).toEqual(before);
          expect(await retainedDocument!.evaluate((node) => node.isConnected)).toBe(true);
          overlaps.push(
            await heading.evaluate((node) => {
              const rect = node.getBoundingClientRect();
              let covered = 0;
              for (let y = rect.top + 2; y < rect.bottom; y += 4) {
                for (let x = rect.left + 2; x < rect.right; x += 4) {
                  if (!node.contains(document.elementFromPoint(x, y))) {
                    covered++;
                  }
                }
              }
              return covered;
            }),
          );
        }
        if (width === 390) {
          const requests = (await gateway.getRequests("forge.detail")).length;
          const actions = panel.getByRole("button", { name: "Link reader actions", exact: true });
          await actions.tap();
          await page
            .getByRole("menu", { name: "Link reader actions", exact: true })
            .getByText("Refresh unavailable. Try again.", { exact: true })
            .waitFor();
          expect((await gateway.getRequests("forge.detail")).length).toBe(requests);
          await actions.tap();
        }
        await content.evaluate((node) => {
          node.scrollTop = 200;
        });
        const scrollTop = await content.evaluate((node) => node.scrollTop);
        const retry = await gateway.deferNext("forge.detail");
        await refresh.click();
        expect(
          (await gateway.waitForRequest("forge.detail", { after: retry })).params,
        ).toMatchObject({ url, refresh: true });
        expect(await content.evaluate((node) => node.scrollTop)).toBe(scrollTop);
        await gateway.resolveDeferred("forge.detail", overview);
        await expect.poll(() => refresh.isEnabled()).toBe(true);
        await content.evaluate((node) => {
          node.scrollTop = 0;
        });
      }
    },
    { hasTouch: true },
  );
  console.log("REFRESH_PROOF", artifacts, overlaps);
  expect(overlaps).toEqual([0, 0, 0, 0, 0, 0]);
});
