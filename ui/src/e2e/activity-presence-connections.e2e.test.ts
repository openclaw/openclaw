import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as expectBrowser } from "playwright/test";
import { it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it("consolidates matching connections without losing watched sessions or diagnostic details", async () => {
    await suite.withPage(
      {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        colorScheme: "light",
        locale: "en-US",
      },
      async ({ page }) => {
        const now = Date.now();
        const person = {
          id: "alex",
          name: "Alex Morgan",
          email: "alex@example.test",
          identity: { type: "profile" as const, id: "alex" },
        };
        const sessions = chatSessionListResponse([
          {
            key: "agent:main:design",
            kind: "direct",
            label: "Review the mobile experience",
            updatedAt: now - 60_000,
          },
          {
            key: "agent:main:release",
            kind: "direct",
            label: "Prepare the release checklist",
            updatedAt: now - 120_000,
          },
        ]);
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:design",
          presenceUsers: [{ ...person }],
          methodResponses: {
            "sessions.list": {
              ...sessions,
              people: [{ identity: person.identity, label: person.name, sessionCount: 2 }],
            },
          },
        });
        await page.goto(new URL("activity/alex", suite.server.baseUrl).href);
        const card = page.locator('[data-activity-identity="alex"]');
        await expectBrowser(card).toBeVisible();
        const entries = Array.from({ length: 4 }, (_, i) => ({
          user: person,
          instanceId: "tab-" + i,
          host: "openclaw-control-ui",
          clientId: "openclaw-control-ui",
          mode: "webchat",
          deviceFamily: "Mac",
          platform: "MacIntel",
          ip: "2001:db8::7",
          timeZone: "America/Los_Angeles",
          ts: now,
          lastActivityAt: now,
          watchedSessions: [i % 2 ? "agent:main:release" : "agent:main:design"],
        }));
        await gateway.emitGatewayEvent("presence", { presence: entries });
        await expectBrowser(
          card.locator(".activity-feed__viewing [data-activity-session]"),
        ).toHaveCount(2);
        const directory = captureUiProofEnabled
          ? createControlUiE2eArtifactDir("activity-presence")
          : undefined;
        const capture = async (name: string) => {
          if (!directory) {
            return;
          }
          const frame = await takeControlUiScreenshotFrame(
            page,
            card,
            [card.getByRole("heading", { name: person.name })],
            { animations: "disabled", scrollTo: card },
          );
          await writeFile(path.join(directory, name), frame.png);
        };
        await capture("mobile-collapsed.png");
        await expectBrowser(card.locator(".activity-feed__connection-summary")).toHaveText(
          "Mac · Web app",
        );
        const details = card.locator("details");
        await expectBrowser(details).not.toHaveAttribute("open", "");
        await expectBrowser(details.locator("summary")).toHaveText("Connection details · 4");
        await details.locator("summary").tap();
        await expectBrowser(details).toHaveAttribute("open", "");
        await expectBrowser(details.locator(".activity-feed__connection")).toHaveCount(1);
        await expectBrowser(details).toContainText("4 connections");
        await expectBrowser(details).toContainText("2001:db8::7");
        await capture("mobile-expanded.png");
        await gateway.emitGatewayEvent("presence", {
          presence: [
            ...entries.slice(0, 3),
            { ...entries[3], deviceFamily: "iPhone", platform: "iOS", ip: "203.0.113.9" },
          ],
        });
        await expectBrowser(details.locator(".activity-feed__connection")).toHaveCount(2);
        await expectBrowser(details).toContainText("3 connections");
        await expectBrowser(details).toContainText("1 connection");
        await expectBrowser(card.locator(".activity-feed__connection-summary")).toContainText(
          "iPhone",
        );
        await expectBrowser(details).toHaveAttribute("open", "");
        await details.locator("summary").tap();
        await capture("mobile-mixed.png");
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.emulateMedia({ colorScheme: "dark" });
        await capture("desktop-mixed.png");
        await gateway.emitGatewayEvent("presence", { presence: [] });
        await expectBrowser(card).toContainText("Offline");
        await expectBrowser(card.locator("details")).toHaveCount(0);
      },
    );
  });
});
