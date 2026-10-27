import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createCronJob,
  cronJobsListResponse,
  cronListResponseFixture,
} from "../test-helpers/cron.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionPerson } from "./session-ownership-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Details warm paint" });

suite.define(() => {
  it("restores native Details before hello and adopts live sections without moving their slots", async () => {
    await suite.withPage(
      { viewport: { width: 1719, height: 1100 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const sessionKey = "agent:main:chat:aabbccdd-2370-4321-9876-123456789abc";
        const childKey = "agent:main:subagent:details-review";
        const text = "The saved conversation and Details return together.";
        const owner = sessionPerson("details-operator", "Morgan");
        const parent = createControlUiSessionRow(sessionKey, "Details warm paint", 1, {
          owner: { actor: owner },
          participants: [{ identity: owner.identity, label: owner.label }],
          participantCount: 1,
          childSessions: [childKey],
        });
        const child = createControlUiSessionRow(childKey, "Review the release", 1, {
          classification: "subagent",
          parentSessionKey: sessionKey,
          spawnedBy: sessionKey,
          createdAt: 1,
        });
        const automation = createCronJob("details-check", "Scheduled release check", {
          agentId: "main",
          owner: { agentId: "main", sessionKey },
          schedule: { kind: "every", everyMs: 600_000 },
        });
        const gateway = await installMockGateway(page, {
          sessionKey,
          authMethod: "trusted-proxy",
          authMode: "trusted-proxy",
          deferredMethods: ["connect"],
          sessions: [parent, child],
          historyMessages: [{ role: "assistant", content: text }],
          featureMethods: [...defaultControlUiFeatureMethods, "progressCard.get"],
          featureEvents: ["cron.inventory.changed"],
          methodResponses: {
            "cron.list": cronListResponseFixture(cronJobsListResponse([automation])),
            "progressCard.get": {
              card: {
                sessionKey,
                revision: 1,
                updatedAt: 1,
                steps: [{ step: "Review the release notes", status: "in_progress" }],
              },
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        await page.getByText(text, { exact: true }).waitFor();
        const pane = page.locator(".chat-pane-cache__pane--active");
        await openChatDetails(page);
        const details = pane.locator(".chat-details").filter({ visible: true });
        const subagents = details.locator('[data-details-group="subagents"]');
        const automations = details.locator('[data-details-group="automations"]');
        const people = details.locator('[data-details-group="people"]');
        const progress = details.locator('[data-progress-card-placement="details"]');
        await subagents
          .getByRole("button", { name: "Review the release Done", exact: true })
          .waitFor();
        await automations.getByText("Scheduled release check", { exact: true }).waitFor();
        await progress.waitFor();
        await expect
          .poll(() => people.locator(".chat-details-people__preview-avatar").count())
          .toBe(1);
        const flushSnapshot = () =>
          page.evaluate(async () => {
            const active = document.querySelector(".chat-pane-cache__pane--active");
            await Reflect.get(active!, "sessionSnapshotStore").flush();
          });
        await automations.locator(":scope > summary").click();
        await expect
          .poll(() => automations.locator(":scope > summary").getAttribute("aria-expanded"))
          .toBe("false");
        await flushSnapshot();

        await page.reload();
        await gateway.waitForRequest("connect");
        await page.getByText(text, { exact: true }).waitFor();
        await subagents
          .getByRole("button", { name: "Review the release Done", exact: true })
          .waitFor();
        await automations.locator(":scope > summary").click();
        await automations.getByText("Scheduled release check", { exact: true }).waitFor();
        await progress.waitFor();
        expect(await people.locator(".chat-details-people__preview-avatar").count()).toBe(1);
        expect(await details.locator("openclaw-panel-loading-skeleton").count()).toBe(0);
        expect(await gateway.getRequests("cron.list")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.describe")).toHaveLength(0);
        const sections = details.locator(
          '[data-details-group], [data-progress-card-placement="details"]',
        );
        const geometry = () =>
          details.evaluate((panel) => {
            const bounds = panel.getBoundingClientRect();
            return {
              left: bounds.left,
              width: bounds.width,
              sections: [
                ...panel.querySelectorAll<HTMLElement>(
                  '[data-details-group], [data-progress-card-placement="details"]',
                ),
              ].map((section) => {
                const box = section.getBoundingClientRect();
                return {
                  section: section.dataset.detailsGroup ?? "progress",
                  top: box.top - bounds.top,
                  height: box.height,
                };
              }),
            };
          });
        await waitForLayoutSettled(page, ".chat-details-desktop-body__content");
        const before = await geometry();
        expect(before.sections.map((section) => section.section)).toEqual([
          "people",
          "subagents",
          "progress",
          "automations",
        ]);
        const retained = await sections.elementHandles();
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("cron.list");
        await gateway.waitForRequest("progressCard.get");
        await expect
          .poll(() => automations.locator(".chat-summary__automations").getAttribute("aria-busy"))
          .toBe("false");
        await waitForLayoutSettled(page, ".chat-details-desktop-body__content");
        expect(await geometry()).toEqual(before);
        for (const section of retained) {
          const state = await section.evaluate((element) => ({
            section: element.getAttribute("data-details-group") ?? "progress",
            connected: element.isConnected,
          }));
          expect(state.connected, state.section).toBe(true);
          await section.dispose();
        }
        await flushSnapshot();

        await gateway.setSessionsListResponse({ sessions: [{ ...parent, childSessions: [] }] });
        await gateway.setMethodResponse("sessions.describe", {
          session: { ...parent, childSessions: [] },
        });
        await gateway.setMethodResponse(
          "cron.list",
          cronListResponseFixture(cronJobsListResponse([])),
        );
        await page.reload();
        await gateway.waitForRequest("connect");
        await subagents
          .getByRole("button", { name: "Review the release Done", exact: true })
          .waitFor();
        await automations.getByText("Scheduled release check", { exact: true }).waitFor();
        await gateway.resolveDeferred("connect");
        await expect.poll(() => subagents.count()).toBe(0);
        await expect.poll(() => automations.count()).toBe(0);
      },
    );
  });
});
