import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

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
  expect(geometry.titleFits).toBe(true);
  if (geometry.offlineGap !== null) {
    expect(geometry.offlineGap).toBeGreaterThanOrEqual(0);
    expect(geometry.offlineGap).toBeLessThanOrEqual(16);
  }
  expect(geometry.fits).toBe(true);
  expect(geometry.actionFits).toBe(true);
  expect(geometry.metaHeight).toBeLessThan(26);
  expect(await incident.locator("p, .sidebar-issues-panel__actions").count()).toBe(0);
}

suite.define(() => {
  it("reviews an unconfirmed submission through System without sending or dismissing it", async () => {
    const artifacts = createControlUiE2eArtifactDir("sidebar-outbox");
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        colorScheme: "dark",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const sessionKey = "agent:main:release-notes";
        const otherKey = "agent:main:planning";
        const gateway = await installMockGateway(page, {
          sessionKey,
          agentModel: "openai/demo-model",
          models: [{ id: "demo-model", name: "Demo model", provider: "openai" }],
          sessions: [
            {
              key: sessionKey,
              displayName: "Release notes",
              kind: "direct",
              updatedAt: 1000,
              model: "demo-model",
              modelProvider: "openai",
            },
            {
              key: otherKey,
              displayName: "Planning",
              kind: "direct",
              updatedAt: 900,
              model: "demo-model",
              modelProvider: "openai",
            },
          ],
          methodResponses: {
            "chat.history": {
              messages: [],
              sessionId: `session:${sessionKey}`,
              sessionInfo: { hasActiveRun: false, status: "done" },
              thinkingLevel: null,
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        await gateway.deferNext("chat.send");
        await composer.fill("Please review the release notes before publishing.");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await gateway.waitForRequest("chat.send");
        await gateway.setOnline(false);
        await page.locator('.chat-send-status[data-send-state="waiting-reconnect"]').waitFor();
        await gateway.setOnline(true);
        const delivery = page.locator('.chat-send-status[data-send-state="unconfirmed"]');
        await delivery.getByText("Delivery unconfirmed", { exact: true }).waitFor();
        await page.screenshot({
          path: path.join(artifacts, "01-chat-review.png"),
          animations: "disabled",
        });

        await page.locator(".sidebar-issues-button").click();
        await page.locator("#sidebar-issues-tab-system").click();
        const incident = page.locator('[data-attention-kind="outbox"]');
        await incident.getByText("Your message may not have arrived", { exact: true }).waitFor();
        expect(await incident.textContent()).toContain("Release notes");
        expect(await incident.textContent()).not.toContain(
          "Please review the release notes before publishing.",
        );
        expect(await incident.getByRole("button").count()).toBe(0);
        expect(await page.locator(".sidebar-footer-bar").textContent()).not.toContain("in outbox");
        await expectCompactRow(incident);
        await page.screenshot({
          path: path.join(artifacts, "02-system-after.png"),
          animations: "disabled",
        });
        await gateway.setOnline(false);
        await incident.locator(".sidebar-outbox-row__offline").waitFor();
        await expectCompactRow(incident);
        await page.locator(".sidebar-footer-bar .gateway-status--reconnecting").waitFor();
        expect(
          await page
            .locator(
              '[data-attention-kind="scopeUpgrade"], [data-attention-kind="updateAvailable"]',
            )
            .count(),
        ).toBe(0);
        await page.screenshot({
          path: path.join(artifacts, "03-system-offline.png"),
          animations: "disabled",
        });
        await incident.getByRole("link", { name: "Review in chat" }).click();
        await delivery.waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        // Review alone leaves custody and the incident intact. Existing Discard owns removal.
        await delivery.getByRole("button", { name: "Discard", exact: true }).click();
        await delivery.waitFor({ state: "detached" });
        await expect.poll(() => page.locator(".sidebar-issues-button").count()).toBe(0);
        expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.abort")).toHaveLength(0);
        await gateway.setOnline(true);
        await composer.fill("An ordinary queued follow-up stays in chat.");
        await gateway.setOnline(false);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page.locator(".chat-queue__item").waitFor();
        await page.locator(".sidebar-footer-bar .gateway-status--reconnecting").waitFor();
        expect(await page.locator(".sidebar-issues-button").count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        await page.screenshot({
          path: path.join(artifacts, "04-ordinary-queue.png"),
          animations: "disabled",
        });
      },
    );
  });
  it.each([390, 320])("keeps long-label recovery rows compact at %ipx", async (width) => {
    const artifacts = createControlUiE2eArtifactDir(`sidebar-outbox-compact-${width}`);
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        colorScheme: "dark",
        reducedMotion: "reduce",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const sessionKey = "agent:main:long-title";
        const gateway = await installMockGateway(page, {
          sessionKey,
          agentModel: "openai/demo-model",
          models: [{ id: "demo-model", name: "Demo model", provider: "openai" }],
          sessions: [
            {
              key: sessionKey,
              displayName:
                "Release planning and documentation review for the upcoming milestone with a deliberately long conversation title",
              kind: "direct",
              updatedAt: 1000,
              model: "demo-model",
              modelProvider: "openai",
            },
          ],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor();
        for (const number of [1, 2]) {
          const after = (await gateway.getRequests("chat.send")).length;
          await gateway.deferNext("chat.send");
          await composer.fill(`Review draft ${number}`);
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          await gateway.waitForRequest("chat.send", { after });
          if (number === 1) {
            await gateway.rejectDeferred("chat.send", {
              code: "INVALID_REQUEST",
              message: "Synthetic delivery rejection",
            });
            await page.locator('.chat-send-status[data-send-state="failed"]').waitFor();
          } else {
            await gateway.setMethodResponse("chat.history", {
              sessionId: `session:${sessionKey}`,
              messages: [],
              sessionInfo: {
                key: sessionKey,
                sessionId: `session:${sessionKey}`,
                status: "done",
                hasActiveRun: false,
              },
            });
            await gateway.setOnline(false);
            await page.locator('.chat-send-status[data-send-state="waiting-reconnect"]').waitFor();
            await gateway.setOnline(true);
            await page.locator('.chat-send-status[data-send-state="unconfirmed"]').waitFor();
          }
        }
        await page.setViewportSize({ width, height: 900 });
        await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
        await page.locator(".sidebar-issues-button:visible").click();
        await page.locator("#sidebar-issues-tab-system").click();
        const incidents = page.locator('[data-attention-kind="outbox"]');
        expect(await incidents.count()).toBe(2);
        expect(await incidents.locator(".sidebar-issues-panel__entity").allTextContents()).toEqual([
          "Your message wasn’t sent",
          "Your message may not have arrived",
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
        await page.screenshot({
          path: path.join(artifacts, "compact-long-labels.png"),
          animations: "disabled",
        });
        expect(await gateway.getRequests("chat.send")).toHaveLength(2);
      },
    );
  });
  it("clears the warning on authoritative pending custody and retires only after consumption", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const sessionKey = "agent:main:late-custody";
        const sessionId = `session:${sessionKey}`;
        const prompt = "Keep this input until it is consumed";
        const history = {
          sessionId,
          messages: [],
          sessionInfo: { key: sessionKey, sessionId, hasActiveRun: false, status: "done" },
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          agentModel: "openai/demo-model",
          models: [{ id: "demo-model", name: "Demo model", provider: "openai" }],
          methodResponses: { "chat.history": history },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.deferNext("chat.send");
        await page.locator(".agent-chat__composer-combobox textarea").fill(prompt);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const runId = requireString(
          requireRecord((await gateway.waitForRequest("chat.send")).params).idempotencyKey,
          "submission id",
        );
        const hasPayload = (sendState?: string) =>
          page.evaluate(
            (expected) =>
              Object.entries(sessionStorage).some(
                ([key, value]) =>
                  key.startsWith("openclaw.control.chatComposer.") &&
                  value.includes(expected.runId) &&
                  (!expected.sendState || value.includes(`"sendState":"${expected.sendState}"`)),
              ),
            { runId, sendState },
          );
        await gateway.setOnline(false);
        await page.locator('.chat-send-status[data-send-state="waiting-reconnect"]').waitFor();
        await gateway.setOnline(true);
        await page.locator('.chat-send-status[data-send-state="unconfirmed"]').waitFor();
        await page.locator(".sidebar-issues-button").click();
        await page.locator("#sidebar-issues-tab-system").click();
        await page
          .locator('[data-attention-kind="outbox"]')
          .getByText("Your message may not have arrived", { exact: true })
          .waitFor();
        await gateway.setOnline(false);
        await gateway.setMethodResponse("chat.history", {
          ...history,
          pendingInputs: {
            total: 1,
            items: [
              {
                id: "accepted-input",
                runId,
                state: "queued",
                acceptedAt: 100,
                message: { role: "user", content: prompt },
              },
            ],
          },
          inputReceipts: [{ runId, state: "pending" }],
        });
        await gateway.setOnline(true);
        await expect.poll(() => hasPayload("waiting-idle")).toBe(true);
        await expect.poll(() => page.locator('[data-attention-kind="outbox"]').count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        await gateway.setOnline(false);
        await gateway.setMethodResponse("chat.history", {
          ...history,
          pendingInputs: { items: [], total: 0 },
          inputReceipts: [{ runId, state: "consumed", consumedByEventId: "canonical-input" }],
        });
        await gateway.setOnline(true);
        await expect.poll(() => hasPayload()).toBe(false);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      },
    );
  });
});
