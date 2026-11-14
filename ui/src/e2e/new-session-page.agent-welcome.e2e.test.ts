import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createPageOpener } from "./new-session-page.scenario.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollCount,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const openPage = createPageOpener(suite);
const description =
  "Follows your repositories and briefs you on meaningful changes, proposals, and decisions.";
const recommendedPrompts = [
  "Set up a repository",
  "Brief me on recent changes",
  "Show my tracked projects",
];

suite.define(() => {
  it("renders agent metadata on desktop and phone and sends only the clicked starter", async () => {
    const page = await openPage({ viewport: { width: 1280, height: 900 } });
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            {
              id: "main",
              name: "Project briefing",
              identity: { emoji: "📋" },
              description,
              recommendedPrompts,
            },
          ],
        },
        "sessions.list": {
          count: 0,
          defaults: { contextTokens: null, model: null, modelProvider: null },
          path: "",
          sessions: [],
          ts: 1,
        },
      },
    });
    await page.goto(suite.server.baseUrl + "new");
    const suggestions = page.locator(".agent-chat__suggestion:visible");
    await suggestions.first().waitFor();
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      const frame = await takeControlUiScreenshotFrame(
        page,
        page.locator(".shell"),
        [page.locator(".agent-chat__welcome")],
        { animations: "disabled" },
      );
      await writeFile(path.join(suite.artifactDir, "welcome-desktop.png"), frame.png);
    }
    expect(await page.locator(".agent-chat__welcome").textContent()).toContain(description);
    expect(await suggestions.allTextContents()).toEqual(recommendedPrompts);
    expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    const incognito = page.getByRole("switch", { name: "Incognito" });
    await incognito.click();
    await pollCount(suggestions).toBe(3);
    expect(await page.locator(".agent-chat__description").textContent()).toBe(description);
    await incognito.click();
    await page.setViewportSize({ width: 390, height: 844 });
    await pollCount(suggestions).toBe(3);
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      const frame = await takeControlUiScreenshotFrame(
        page,
        page.locator(".shell"),
        [page.locator(".agent-chat__welcome")],
        { animations: "disabled" },
      );
      await writeFile(path.join(suite.artifactDir, "welcome-phone.png"), frame.png);
    }
    await page.setViewportSize({ width: 320, height: 568 });
    await suggestions.last().scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await suggestions.nth(1).click();
    const request = await gateway.waitForRequest("sessions.create");
    expect(request.params).toMatchObject({ message: "Brief me on recent changes" });
  });
});
