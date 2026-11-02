import { expect as expectBrowser } from "playwright/test";
import { it } from "vitest";
import {
  captureUiProof,
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
        locale: "en-US",
      },
      async ({ page }) => {
        const now = Date.now();
        const person = {
          id: "alex",
          name: "Alex Morgan",
          identity: { type: "profile" as const, id: "alex" },
        };
        const keys = ["agent:main:design", "agent:main:release"];
        const sessions = chatSessionListResponse(
          keys.map((key, index) => ({
            key,
            kind: "direct",
            label: `Session ${index}`,
            updatedAt: now - (index + 1) * 60_000,
          })),
        );
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:design",
          presenceUsers: [person],
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
          clientId: "openclaw-control-ui",
          mode: "webchat",
          deviceFamily: "Mac",
          platform: "MacIntel",
          ip: "2001:db8::7",
          ts: now,
          lastActivityAt: now,
          watchedSessions: [keys[i % 2]],
        }));
        await gateway.emitGatewayEvent("presence", { presence: entries });
        const watched = card.locator(".activity-feed__viewing [data-activity-session]");
        await expectBrowser(watched).toHaveCount(2);
        const capture = (name: string) => captureUiProof(suite, page, "activity-presence", name);
        await capture("mobile-collapsed.png");
        const summary = card.locator(".activity-feed__connection-summary");
        await expectBrowser(summary).toHaveText("Mac · Web app");
        const details = card.locator("details");
        await expectBrowser(details).not.toHaveAttribute("open", "");
        await expectBrowser(details.locator("summary")).toHaveText("Connection details · 4");
        await details.locator("summary").tap();
        await expectBrowser(details).toHaveAttribute("open", "");
        await expectBrowser(details.locator(".activity-feed__connection")).toHaveCount(1);
        await expectBrowser(details).toContainText(/4 connections[\s\S]*2001:db8::7/);
        await capture("mobile-expanded.png");
        await gateway.emitGatewayEvent("presence", {
          presence: [
            ...entries.slice(0, 3),
            { ...entries[3], deviceFamily: "iPhone", platform: "iOS", ip: "203.0.113.9" },
          ],
        });
        await expectBrowser(details.locator(".activity-feed__connection")).toHaveCount(2);
        await expectBrowser(details).toContainText(/3 connections[\s\S]*1 connection/);
        await expectBrowser(summary).toContainText("iPhone");
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
