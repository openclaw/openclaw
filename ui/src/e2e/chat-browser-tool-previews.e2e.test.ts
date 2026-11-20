import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiElementScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Browser tool results without preview cards" });
const sessionKey = "agent:main:dashboard:browser-tool-previews";
const url = "https://github.com/openclaw/openclaw/pull/197528";
const visit = (id: string, profile: string, runId: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "browser",
  content: "Page inspected.",
  __openclaw: { id, runId },
  details: {
    browserTab: { target: "host", profile, targetId: id, url, title: "Fix completed chat work" },
  },
});
const history = [
  { role: "user", content: "Publish the fix and verify the pull request." },
  visit("first-visit", "lightpanda", "first-run"),
  {
    role: "assistant",
    content: "The pull request is published.",
    stopReason: "stop",
    __openclaw: { runId: "first-run" },
  },
  {
    role: "assistant",
    content: "Published openclaw/openclaw#197528.",
    provider: "openclaw",
    model: "gateway-publication",
    stopReason: "stop",
  },
  visit("second-visit", "lightpanda", "second-run"),
  visit("third-visit", "chromium", "second-run"),
  {
    role: "assistant",
    content: "Verified [PR #197528](" + url + "). The fix is ready for review.",
    stopReason: "stop",
    __openclaw: { runId: "second-run" },
  },
].map((message, index) => Object.assign(message, { timestamp: 1_800_000_000_000 + index * 1_000 }));

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "keeps browser output without automatic cards after expansion and reload (%s)",
    async (theme) => {
      await suite.withPage(
        { viewport: { width: 1200, height: 950 }, colorScheme: theme, reducedMotion: "reduce" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, { sessionKey, historyMessages: history });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const thread = page.locator(".chat-thread");
          const reply = thread.getByText("The fix is ready for review.", { exact: false });
          await reply.waitFor();
          const work = thread.locator(".chat-work-group .chat-activity-group__summary");
          await work.first().waitFor();
          const directory = createControlUiE2eArtifactDir(
            "browser-previews-" + theme,
            process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR,
          );
          await fs.writeFile(
            path.join(directory, "collapsed.png"),
            await takeControlUiElementScreenshot(page, page.locator(".chat-main"), [
              reply,
              work.first(),
            ]),
          );
          expect(await thread.locator("openclaw-browser-tab-card").count()).toBe(0);
          expect(await gateway.getRequests("browser.request")).toHaveLength(0);
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await composer.fill("Keep this draft while I inspect the work.");
          await work.first().click();
          const tool = thread.locator(".chat-tool-msg-summary").first();
          await tool.waitFor();
          expect(await thread.locator("openclaw-browser-tab-card").count()).toBe(0);
          await tool.click();
          const output = thread.locator(".chat-tool-msg-body").first();
          await output.getByText("Page inspected.", { exact: true }).waitFor();
          await fs.writeFile(
            path.join(directory, "expanded.png"),
            await takeControlUiElementScreenshot(page, page.locator(".chat-main"), [output]),
          );
          expect(await thread.locator("openclaw-browser-tab-card").count()).toBe(0);
          expect(await gateway.getRequests("browser.request")).toHaveLength(0);
          expect(await gateway.getRequests("controlUi.linkPreview")).toHaveLength(0);
          await work.first().click();
          await expect.poll(() => thread.locator("openclaw-browser-tab-card").count()).toBe(0);
          expect(await composer.inputValue()).toBe("Keep this draft while I inspect the work.");
          await page.reload();
          await reply.waitFor();
          expect(await thread.locator("openclaw-browser-tab-card").count()).toBe(0);
          expect(await thread.locator('a[href="' + url + '"]').count()).toBeGreaterThan(0);
        },
      );
    },
  );
});
