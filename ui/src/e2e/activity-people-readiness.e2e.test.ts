import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Activity People count readiness",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it.each([1280, 390])("keeps unknown and zero People counts distinct at %s px", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 900 }, locale: "en-US", colorScheme: "light" },
      async ({ page }) => {
        const key = "agent:main:activity-people-readiness";
        const listing = {
          ...chatSessionListResponse([
            { key, kind: "direct", label: "Release work", updatedAt: Date.now(), agentId: "main" },
          ]),
          people: [{ identity: { type: "profile", id: "alice" }, label: "Alice", sessionCount: 1 }],
          peopleSessionCount: 1,
        };
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          methodResponses: { "sessions.list": listing },
        });
        await page.goto(suite.server.baseUrl + "activity");
        await page.locator('[data-activity-session="' + key + '"]').waitFor();
        await gateway.deferNext("sessions.list", { includePeople: true, search: "release" });
        await page.locator(".activity-feed__search input").fill("release");
        await gateway.waitForRequest("sessions.list", {
          match: { includePeople: true, search: "release" },
        });
        await page.locator(".activity-feed__people-trigger").click();
        const count = page.locator('[data-activity-person=""] .activity-feed__people-count');
        await page.locator('[data-activity-person=""]').waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const artifacts = createControlUiE2eArtifactDir("activity-people-readiness");
          const target = page.locator(".activity-feed__people-popover");
          const frame = await takeControlUiScreenshotFrame(page, target, [target], {
            elements: [target],
            animations: "disabled",
          });
          await writeFile(path.join(artifacts, `pending-people-${width}.png`), frame.png);
        }
        expect.soft(await count.textContent()).toBe("");
        await gateway.rejectDeferred("sessions.list", {
          code: "UNAVAILABLE",
          message: "Activity query temporarily unavailable",
        });
        await page
          .getByRole("alert")
          .filter({ hasText: "Activity query temporarily unavailable" })
          .waitFor();
        expect.soft(await count.textContent()).toBe("");
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await page.locator('[data-activity-session="' + key + '"]').waitFor();
        await page.locator(".activity-feed__people-trigger").click();
        await expect.poll(() => count.textContent()).toBe("1");
        await page.keyboard.press("Escape");
        await gateway.setSessionsListResponse({
          ...chatSessionListResponse([]),
          people: [],
          peopleSessionCount: 0,
        });
        await page.locator(".activity-feed__search input").fill("missing");
        await page.locator(".activity-feed__empty").waitFor();
        await page.locator(".activity-feed__people-trigger").click();
        await expect.poll(() => count.textContent()).toBe("0");
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      },
    );
  });
});
