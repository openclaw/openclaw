import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { expectCount } from "./sidebar-assertions.test-support.ts";

const suite = createChatFlowE2eSuite();
const pageOptions = {
  viewport: { width: 1280, height: 900 },
  locale: "en-US",
  colorScheme: "dark",
  serviceWorkers: "block",
} as const;

async function openOutbox(
  page: Page,
  scenario: ControlUiMockGatewayScenario & { sessionKey: string },
) {
  const gateway = await installMockGateway(page, scenario);
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, scenario.sessionKey));
  const composer = page.locator(".agent-chat__composer-combobox textarea");
  await composer.waitFor();
  return { gateway, composer };
}

function outboxSession(key: string, displayName: string) {
  return { key, displayName, kind: "direct" as const };
}

async function expectReservedInbox(page: Page) {
  await expectCount(page.locator(".sidebar-issues-button:enabled"), 0);
  expect(await page.locator(".sidebar-issues-button").count()).toBe(1);
  expect(await page.locator(".sidebar-issues-button__count").count()).toBe(0);
}

async function expectCompactRow(incident: Locator) {
  const geometry = await incident.locator(".sidebar-outbox-row").evaluate((element) => {
    const row = element.getBoundingClientRect();
    const content = element
      .querySelector(".sidebar-issues-panel__content")!
      .getBoundingClientRect();
    const action = element.querySelector("a")!.getBoundingClientRect();
    const meta = element.querySelector(".sidebar-outbox-row__meta")!.getBoundingClientRect();
    const title = element.querySelector(".sidebar-issues-panel__entity")!;
    const context = element.querySelector(".sidebar-issues-panel__state")!;
    const offline = element.querySelector(".sidebar-outbox-row__offline");
    const contextText = document.createRange();
    contextText.selectNodeContents(context);
    return {
      height: row.height,
      fits: element.scrollWidth <= element.clientWidth,
      actionFits: action.right <= row.right && action.left >= content.right,
      metaHeight: meta.height,
      titleFits:
        title.scrollWidth <= title.clientWidth && title.scrollHeight <= title.clientHeight + 1,
      offlineGap:
        offline && context.scrollWidth <= context.clientWidth
          ? offline.getBoundingClientRect().left - contextText.getBoundingClientRect().right
          : null,
    };
  });
  expect(geometry.height).toBeGreaterThanOrEqual(64);
  expect(geometry.height).toBeLessThanOrEqual(96);
  expect(geometry).toMatchObject({ titleFits: true, fits: true, actionFits: true });
  if (geometry.offlineGap !== null) {
    expect(geometry.offlineGap).toBeGreaterThanOrEqual(0);
    expect(geometry.offlineGap).toBeLessThanOrEqual(16);
  }
  expect(geometry.metaHeight).toBeLessThan(26);
  expect(await incident.locator("p, .sidebar-issues-panel__actions").count()).toBe(0);
}

suite.define(() => {
  it("reviews a rejected submission through System without sending or deleting its draft", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const sessionKey = "agent:main:release-notes";
      const { gateway, composer } = await openOutbox(page, {
        sessionKey,
        sessions: [outboxSession(sessionKey, "Release notes")],
        methodResponses: {
          "chat.history": {
            messages: [],
            sessionId: `session:${sessionKey}`,
            sessionInfo: { hasActiveRun: false, status: "done" },
            thinkingLevel: null,
          },
        },
      });
      await gateway.deferNext("chat.send");
      await composer.fill("Please review the release notes before publishing.");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await gateway.waitForRequest("chat.send");
      await gateway.rejectDeferred("chat.send", {
        code: "INVALID_REQUEST",
        message: "Synthetic delivery rejection",
      });
      const delivery = page.locator('.chat-send-status[data-send-state="failed"]');
      await delivery.getByText("Not sent", { exact: true }).waitFor();

      await page.locator(".sidebar-issues-button").click();
      await page.locator("#sidebar-issues-tab-system").click();
      const incident = page.locator('[data-attention-kind="outbox"]');
      await incident.getByText("Your message wasn’t sent", { exact: true }).waitFor();
      expect(await incident.textContent()).toContain("Release notes");
      expect(await incident.textContent()).not.toContain(
        "Please review the release notes before publishing.",
      );
      expect(await incident.getByRole("button").count()).toBe(0);
      expect(await page.locator(".sidebar-footer-bar").textContent()).not.toContain("in outbox");
      await expectCompactRow(incident);
      await gateway.setOnline(false);
      await incident.locator(".sidebar-outbox-row__offline").waitFor();
      await expectCompactRow(incident);
      await page.locator(".sidebar-shell__footer .gateway-status--reconnecting").waitFor();
      expect(
        await page
          .locator('[data-attention-kind="scopeUpgrade"], [data-attention-kind="updateAvailable"]')
          .count(),
      ).toBe(0);
      await incident.getByRole("link", { name: "Review in chat" }).click();
      await delivery.waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      // Review clears the notification but preserves the draft for explicit recovery.
      await expectReservedInbox(page);
      await delivery.getByRole("button", { name: "Discard", exact: true }).click();
      await delivery.waitFor({ state: "detached" });
      await expectReservedInbox(page);
      expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.abort")).toHaveLength(0);
      await gateway.setOnline(true);
      await composer.fill("An ordinary queued follow-up stays in chat.");
      await gateway.setOnline(false);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.locator(".chat-queue__item").waitFor();
      await page
        .locator(".sidebar-shell__footer .gateway-status")
        .getByText("Reconnecting… · 1 queued", { exact: true })
        .waitFor();
      expect(
        await page.locator(".sidebar-shell__footer .gateway-status").getByRole("button").count(),
      ).toBe(0);
      await expectReservedInbox(page);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
    });
  });
  it("keeps long-label recovery rows compact at 320px", async () => {
    const width = 320;
    await suite.withPage({ ...pageOptions, reducedMotion: "reduce" }, async ({ page }) => {
      const sessionKey = "agent:main:long-title";
      const { gateway, composer } = await openOutbox(page, {
        sessionKey,
        sessions: [
          outboxSession(
            sessionKey,
            "Release planning and documentation review for the upcoming milestone with a deliberately long conversation title",
          ),
        ],
      });
      for (const number of [1, 2]) {
        const after = (await gateway.getRequests("chat.send")).length;
        await gateway.deferNext("chat.send");
        await composer.fill(`Review draft ${number}`);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await gateway.waitForRequest("chat.send", { after });
        await gateway.rejectDeferred("chat.send", {
          code: "INVALID_REQUEST",
          message: "Synthetic delivery rejection",
        });
        await expectCount(page.locator('.chat-send-status[data-send-state="failed"]'), number);
      }
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
      await page.locator(".sidebar-issues-button:visible").click();
      await page.locator("#sidebar-issues-tab-system").click();
      const incidents = page.locator('[data-attention-kind="outbox"]');
      expect(await incidents.count()).toBe(2);
      expect(await incidents.locator(".sidebar-issues-panel__entity").allTextContents()).toEqual([
        "Your message wasn’t sent",
        "Your message wasn’t sent",
      ]);
      for (const incident of await incidents.all()) {
        await expectCompactRow(incident);
        expect(
          await incident
            .locator(".sidebar-issues-panel__state")
            .evaluate((element) => element.scrollWidth > element.clientWidth),
        ).toBe(true);
      }
      await page.mouse.move(0, 0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(2);
    });
  });
  it("keeps pending submissions out of System and retires them on duplicate acknowledgment", async () => {
    await suite.withPage(pageOptions, async ({ page }) => {
      const sessionKey = "agent:main:late-custody";
      const { gateway, composer } = await openOutbox(page, {
        sessionKey,
        heldMethods: ["chat.send"],
      });
      await composer.fill("Reconcile this pending input");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const first = await gateway.waitForRequest("chat.send");
      const runId = requireString(requireRecord(first.params).idempotencyKey, "submission id");
      await gateway.setOnline(false);
      const pending = page.locator('.chat-send-status[data-send-state="waiting-reconnect"]');
      await pending.getByText("Waiting for reconnect", { exact: true }).waitFor();
      await expectReservedInbox(page);
      await gateway.setOnline(true);
      const replay = await gateway.waitForRequest("chat.send", { after: 1 });
      expect(replay.params).toEqual({
        ...requireRecord(first.params),
        __controlUiReconnectResume: true,
      });
      await expectCount(page.locator(".sidebar-issues-button__count"), 0);
      await page.locator(".sidebar-issues-button").click();
      await page.locator("#sidebar-issues-tab-system").click();
      await expectCount(page.locator('[data-attention-kind="outbox"]'), 0);
      await page.keyboard.press("Escape");
      await gateway.resolveDeferred("chat.send", { runId, status: "queued" });
      await page.locator(".chat-send-status").waitFor({ state: "detached" });
      await expectCount(page.locator(".sidebar-issues-button__count"), 0);
      expect(
        await page.evaluate(
          (id) =>
            Object.entries(sessionStorage).some(
              ([key, value]) =>
                key.startsWith("openclaw.control.chatComposer.") && value.includes(id),
            ),
          runId,
        ),
      ).toBe(false);
      expect(await gateway.getRequests("chat.send")).toHaveLength(2);
    });
  });
});
