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
    subtitle: "example/release-engineering-and-deployment-automation #203950",
    badge: { label: "Open", tone: "positive" },
    createdAt: "2026-09-23T11:08:47Z",
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
        .locator(".lr-document-header")
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
        const reference = panel.locator(".lr-eyebrow");
        const referenceNumberIsVisible = () =>
          reference.evaluate((node) => {
            const text = node.textContent ?? "";
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            let offset = text.lastIndexOf("#203950");
            for (let part = walker.nextNode(); part; part = walker.nextNode()) {
              const length = part.textContent?.length ?? 0;
              if (offset >= 0 && offset + 7 <= length) {
                const range = document.createRange();
                range.setStart(part, offset);
                range.setEnd(part, offset + 7);
                const number = range.getBoundingClientRect();
                const ink = part.parentElement!.getBoundingClientRect();
                return number.width > 0 && number.right <= ink.right + 1;
              }
              offset -= length;
            }
            return false;
          });
        expect(await referenceNumberIsVisible()).toBe(true);
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
            // The failure takes the date's place in the header; the title below stays put.
            const notice = panel.locator(".lr-document-header .lr-notice");
            expect(await notice.textContent()).toBe("Refresh unavailable. Try again.");
            // The reference gives way before the notice does, even in a phone-width pane.
            expect(await notice.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(
              true,
            );
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
        await content.evaluate((node) => {
          node.scrollTop = 200;
        });
        const scrollTop = await content.evaluate((node) => node.scrollTop);
        const retry = await gateway.deferNext("forge.detail");
        // Refresh sits in the document header; a pointer click would scroll back to it first.
        await refresh.dispatchEvent("click");
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
      const longError = "GitHub API rate limit exceeded (HTTP 429). Wait 60 seconds and retry.";
      const after = await gateway.deferNext("forge.detail");
      await refresh.click();
      await gateway.waitForRequest("forge.detail", { after });
      await gateway.rejectDeferred("forge.detail", {
        code: "UNAVAILABLE",
        message: longError,
        retryable: true,
      });
      await expect.poll(() => refresh.isEnabled()).toBe(true);
      const disclosure = panel.getByRole("button", { name: longError, exact: true });
      expect(await disclosure.isVisible()).toBe(true);
      const details = panel.getByRole("dialog", { name: longError, exact: true });
      await disclosure.tap();
      const expanded = await takeControlUiScreenshotFrame(page, panel, [details], {
        animations: "disabled",
      });
      writeFileSync(path.join(artifacts, "390-error-expanded.png"), expanded.png);
      expect(await details.textContent()).toBe(longError);
      const bounds = await details.boundingBox();
      const titleBounds = await heading.boundingBox();
      expect(Math.abs(bounds!.x - titleBounds!.x)).toBeLessThan(1);
      expect(await details.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.keyboard.press("Escape");
      await details.waitFor({ state: "hidden" });
      await expect.poll(() => disclosure.getAttribute("aria-expanded")).toBe("false");
      await disclosure.press("Enter");
      await details.waitFor({ state: "visible" });
      expect(await disclosure.getAttribute("aria-expanded")).toBe("true");
    },
    { hasTouch: true },
  );
  console.log("REFRESH_PROOF", artifacts, overlaps);
  expect(overlaps).toEqual([0, 0, 0, 0, 0, 0]);
});
