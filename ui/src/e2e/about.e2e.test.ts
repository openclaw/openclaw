import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { expectAttribute, expectText, showHeading } from "./activity-assertions.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI About mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const BUILT_AT = "2026-07-10T12:34:56.000Z";

suite.define(() => {
  it("shows browser and Gateway build identity for a member", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.sessions.read", "operator.sessions.write"],
      serverCommit: "abcdef0",
      serverBuiltAt: "2026-10-21T11:55:00.000Z",
    });

    try {
      const response = await page.goto(`${suite.server.baseUrl}settings/about`);
      expect(response?.status()).toBe(200);
      await showHeading(page, "Settings");

      const aboutLink = page.getByRole("link", { name: "About", exact: true });
      await expectAttribute(aboutLink, "aria-current").toBe("page");

      const ui = page.locator('dl.settings-kv[aria-label="Control UI build details"]');
      const gatewayFacts = page.locator('dl.settings-kv[aria-label="Gateway"]');
      const fact = (list: typeof ui, term: string) =>
        list.locator("dt", { hasText: term }).locator("xpath=following-sibling::dd[1]");
      await expectText(fact(ui, "Version")).toBe("2026.7.10");
      const commit = fact(ui, "Commit").locator("code");
      await expectText(commit).toBe(COMMIT.slice(0, 7));
      await expectAttribute(commit, "title").toBe(COMMIT);
      await expectAttribute(fact(ui, "Built").locator("time"), "datetime").toBe(BUILT_AT);
      await expectText(fact(gatewayFacts, "Version")).toBe("e2e");
      await expectText(fact(gatewayFacts, "Commit").locator("code")).toBe("abcdef0");
      await expectAttribute(fact(gatewayFacts, "Built").locator("time"), "datetime").toBe(
        "2026-10-21T11:55:00.000Z",
      );
      expect(await page.locator(".settings-section__desc").count()).toBe(0);
      const rail = page.locator("openclaw-about-page .settings-section").last();

      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const surface = page.locator("openclaw-about-page");
        for (const viewport of [
          { name: "desktop", width: 1280, height: 1000 },
          { name: "mobile", width: 390, height: 1000 },
        ]) {
          const frame = await takeControlUiScreenshotFrame(page, surface, [rail], {
            animations: "disabled",
            viewport,
          });
          await writeFile(
            path.join(suite.artifactDir, `about-build-${viewport.name}.png`),
            frame.png,
          );
        }
        await page.emulateMedia({ colorScheme: "dark" });
        const dark = await takeControlUiScreenshotFrame(page, surface, [rail], {
          animations: "disabled",
          viewport: { width: 1280, height: 1000 },
        });
        await writeFile(path.join(suite.artifactDir, "about-build-desktop-dark.png"), dark.png);
        await page.emulateMedia({ colorScheme: "light" });
        await page.setViewportSize({ width: 1280, height: 1000 });
        console.log(`About proof: ${suite.artifactDir}`);
      }

      // The shared control swaps its accessible name to the result, so keep the element handle.
      const copy = fact(gatewayFacts, "Commit").locator(".chat-copy-btn");
      await expectAttribute(copy, "aria-label").toBe("Copy full commit hash");
      await copy.click();
      await expect.poll(() => copy.getAttribute("data-copy-state")).toMatch(/^(copied|error)$/u);
      expect(await gateway.getRequests("system.info")).toHaveLength(0);
      expect(await gateway.getRequests("update.status")).toHaveLength(0);

      const clawd = page.getByRole("button", { name: "Wave hello to Clawd" });
      // CLAWD_WAVE_MS clears the class after 1400ms, so click and read it in one browser step.
      const clawdWaving = await clawd.evaluate(async (element) => {
        const button = element as HTMLButtonElement;
        const owner = element.closest("openclaw-about-page") as
          | (HTMLElement & {
              updateComplete: Promise<unknown>;
            })
          | null;
        if (!owner) {
          throw new Error("About page owner is unavailable");
        }
        button.click();
        await owner.updateComplete;
        return button.classList.contains("about-hero__clawd--wave");
      });
      expect(clawdWaving).toBe(true);

      await page.setViewportSize({ height: 812, width: 375 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  });
});
