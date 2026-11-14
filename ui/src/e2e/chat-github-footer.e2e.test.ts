import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "GitHub source footer",
  startServerBeforeBrowser: true,
});
const sources = [
  ["Release notes for the latest maintenance release", "releases/tag/v1.2.3"],
  [
    "fix(sessions): prevent OOM from consumed input history · Pull Request #101 · example/project · GitHub",
    "pull/101",
  ],
  [
    "fix(sessions): avoid worker OOM during large transcript index repair · example/project · GitHub",
    "commit/abcdef1234567",
  ],
  [
    "fix(memory): stream session exports through acknowledged pages · Pull Request #102 · example/project · GitHub",
    "pull/102",
  ],
  [
    "fix: reduce heap spikes during long-session compaction · Pull Request #103 · example/project · GitHub",
    "pull/103",
  ],
  [
    "Update fails: candidate startup exits and rolls back · Issue #104 · example/project · GitHub",
    "issues/104",
  ],
  [
    "fix(update): roll back activated releases that fail startup · Pull Request #105 · example/project · GitHub",
    "pull/105",
  ],
  [
    "Large session repeatedly kills the worker · Issue #106 · example/project · GitHub",
    "issues/106",
  ],
];
const text =
  "**Bottom line:** prioritize the session-memory fixes and keep the unresolved upgrade investigation separate.\n\nThis was a read-only assessment. No production changes were performed.\n\n" +
  sources
    .map(([title, path]) => `[${title}](https://github.com/example/project/${path})`)
    .join(" ");

suite.define(() => {
  it.each([1200, 400])("keeps all sources comma-separated and visible at %s px", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: [{ type: "text", text }] }],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const surface = page.locator(".chat-text").filter({ hasText: "Bottom line:" }).first();
        await surface.waitFor();
        const footer = surface.locator("p").last();
        const frame = await takeControlUiScreenshotFrame(
          page,
          surface,
          [surface.getByText("Bottom line:", { exact: true })],
          {
            elements: [surface],
            animations: "disabled",
            scrollTo: surface,
          },
        );
        await writeFile(`${suite.artifactDir}/after-${width}.png`, frame.elements[0]!.png);
        expect(await footer.count()).toBe(1);
        expect(await footer.locator("br, details, summary").count()).toBe(0);
        expect(await footer.textContent()).toContain(", #101, ");
        expect(await footer.locator("a").count()).toBe(8);
        expect(await footer.locator('a[href$="/pull/101"]').textContent()).toBe("#101");
        const last = footer.locator('a[href$="/issues/106"]');
        expect(await last.isVisible()).toBe(true);
        expect(await footer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
      },
    );
  });
});
