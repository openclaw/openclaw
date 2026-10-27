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
          state: {
            autoDisabled: { reason: "consecutive-failures", atMs: 1, consecutiveErrors: 3 },
          },
        });
        const gateway = await installMockGateway(page, {
          sessionKey,
          authMethod: "trusted-proxy",
          authMode: "trusted-proxy",
          deferredMethods: ["connect"],
          sessions: [parent, child],
          historyMessages: [{ role: "assistant", content: text }],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "progressCard.get",
            "progressCard.refresh",
          ],
          featureEvents: ["cron.inventory.changed"],
          methodResponses: {
            "cron.list": cronListResponseFixture(
              cronJobsListResponse([
                automation,
                ...Array.from({ length: 10 }, (_, index) =>
                  createCronJob(`details-check-${index}`, `Scheduled release check ${index}`, {
                    agentId: "main",
                    owner: { agentId: "main", sessionKey },
                  }),
                ),
              ]),
            ),
            "artifacts.list": {
              artifacts: [
                {
                  id: "release-notes",
                  title: "Release notes.md",
                  mimeType: "text/markdown",
                  sizeBytes: 512,
                  type: "document",
                  download: { mode: "bytes" },
                },
              ],
            },
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
        const outputs = details.locator('[data-details-group="outputs"]');
        const count = outputs.locator(".chat-details-desktop-section__count");
        const refresh = progress.locator(".task-progress-details__refresh");
        const more = automations.locator(".chat-summary__automation-more");
        const controlAppearance = () =>
          details
            .locator(".task-progress-details__refresh, .chat-summary__automation-more")
            .evaluateAll((buttons) =>
              buttons.map((button) => {
                const style = getComputedStyle(button);
                return [button.className, style.opacity, style.color, style.cursor];
              }),
            );
        await subagents
          .getByRole("button", { name: "Review the release Done", exact: true })
          .waitFor();
        await automations.getByText("Scheduled release check", { exact: true }).waitFor();
        await automations.locator(".chat-summary__automation-attention").waitFor();
        await progress.waitFor();
        await expect.poll(() => count.textContent()).toBe("·1");
        const liveAppearance = await controlAppearance();
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
        if (
          (await automations.locator(":scope > summary").getAttribute("aria-expanded")) !== "false"
        ) {
          await automations.locator(":scope > summary").click();
        }
        await automations.locator(':scope > summary[aria-expanded="false"]').waitFor();
        await automations.locator(":scope > summary").click();
        await automations.getByText("Scheduled release check", { exact: true }).waitFor();
        expect(await automations.locator(".chat-summary__automation-attention").count()).toBe(1);
        await progress.waitFor();
        expect(await count.textContent()).toBe("·1");
        expect(await refresh.getAttribute("aria-disabled")).toBe("true");
        expect(await refresh.getAttribute("disabled")).toBeNull();
        expect(await controlAppearance()).toEqual(liveAppearance);
        const retainedRefresh = await refresh.elementHandle();
        await refresh.click({ force: true });
        await refresh.press("Enter");
        await refresh.press("Space");
        expect(await gateway.getRequests("progressCard.refresh")).toHaveLength(0);
        expect(await more.getAttribute("aria-disabled")).toBe("true");
        expect(await more.getAttribute("disabled")).toBeNull();
        await more.click({ force: true });
        await more.press("Enter");
        expect(await gateway.getRequests("cron.list")).toHaveLength(0);
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
                  left: box.left - bounds.left,
                  width: box.width,
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
          "outputs",
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
        expect(await count.textContent()).toBe("·1");
        expect(await refresh.getAttribute("aria-disabled")).toBeNull();
        expect(await retainedRefresh?.evaluate((button) => button.isConnected)).toBe(true);
        await retainedRefresh?.dispose();
        expect(await gateway.getRequests("progressCard.refresh")).toHaveLength(0);
        for (const section of retained) {
          const state = await section.evaluate((element) => {
            if (!(element instanceof Element)) {
              throw new Error("Details section must be an element");
            }
            return {
              section: element.getAttribute("data-details-group") ?? "progress",
              connected: element.isConnected,
            };
          });
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
