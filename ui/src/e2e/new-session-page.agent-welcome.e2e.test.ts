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
  it.each(["custom", "recent", "default"] as const)(
    "uses the original welcome layout for %s recommendations",
    async (scenario) => {
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
                ...(scenario === "default" ? {} : { recommendedPrompts }),
              },
            ],
          },
          "sessions.list": {
            count: scenario === "recent" ? 1 : 0,
            defaults: { contextTokens: null, model: null, modelProvider: null },
            path: "",
            ts: 1,
            sessions:
              scenario === "recent"
                ? [
                    {
                      key: "agent:main:dashboard:11111111-1111-4111-8111-111111111111",
                      sessionId: "11111111-1111-4111-8111-111111111111",
                      kind: "direct",
                      label: "Plan a research briefing",
                      updatedAt: Date.now() - 60_000,
                    },
                  ]
                : [],
          },
        },
      });
      await page.goto(suite.server.baseUrl + "new");
      const welcome = page.locator(".agent-chat__welcome");
      const suggestions = page.locator(".agent-chat__suggestion:visible");
      if (scenario === "recent") {
        await page
          .locator(".agent-chat__recent-name")
          .getByText("Plan a research briefing", { exact: true })
          .waitFor();
      } else {
        await suggestions.first().waitFor();
      }
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [welcome], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, `welcome-${scenario}.png`), frame.png);
      }
      expect(await welcome.textContent()).toContain(description);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      if (scenario === "recent") {
        expect(await suggestions.count()).toBe(0);
        return;
      }
      if (scenario === "default") {
        expect(await suggestions.allTextContents()).toEqual([
          "What can you do?",
          "Summarize my recent sessions",
          "Help me configure a channel",
          "Check system health",
        ]);
        return;
      }
      expect(await suggestions.allTextContents()).toEqual(recommendedPrompts);
      const incognito = page.getByRole("switch", { name: "Incognito" });
      await incognito.click();
      await pollCount(suggestions).toBe(0);
      await incognito.click();
      await pollCount(suggestions).toBe(3);
      await page.setViewportSize({ width: 390, height: 844 });
      await pollCount(suggestions).toBe(0);
      expect(await page.locator(".agent-chat__description").textContent()).toBe(description);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.setViewportSize({ width: 1280, height: 900 });
      await pollCount(suggestions).toBe(3);
      await suggestions.nth(1).click();
      const request = await gateway.waitForRequest("sessions.create");
      expect(request.params).toMatchObject({ message: "Brief me on recent changes" });
    },
  );
});
