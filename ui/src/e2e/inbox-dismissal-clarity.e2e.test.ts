import { expect, it } from "vitest";
import { createCronJob, cronJobsListResponse } from "../lib/cron/cron.test-support.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { compactCronJobFixture } from "../test-helpers/cron.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Inbox dismissal clarity" });
const failedJob = createCronJob("release-digest", "Release digest", {
  agentId: "main",
  schedule: { kind: "every", everyMs: 60_000 },
  state: { lastRunStatus: "error", lastError: "Provider request failed" },
});

suite.define(() => {
  it.each([1280, 390])("dismisses notifications, not approvals or work, at %ipx", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 900 }, colorScheme: "dark", locale: "en-US" },
      async ({ page }) => {
        const notificationAt = Date.now() - 5 * 60_000;
        const gateway = await installMockGateway(page, {
          presenceUsers: [
            { self: true, id: "alex", name: "Alex", identity: { type: "profile", id: "alex" } },
          ],
          featureMethods: [...defaultControlUiFeatureMethods, "mentions.list", "mentions.dismiss"],
          methodResponses: {
            "update.status": {
              activeRun: null,
              lastRun: createUpdateRunFixture({
                status: "succeeded",
                phase: "finished",
                createdAtMs: notificationAt - 60_000,
                updatedAtMs: notificationAt,
                finishedAtMs: notificationAt,
                after: { version: "2026.9.2" },
              }),
            },
            "models.authStatus": { providers: [], ts: 1 },
            "cron.list": {
              ...cronJobsListResponse(),
              jobs: [compactCronJobFixture(failedJob)],
              total: 1,
              snapshotRevision: "dismissal-fixture",
            },
            "mentions.list": {
              gatewayInstanceId: "e2e-gateway-boot",
              revision: 1,
              items: [
                {
                  id: "mention-review",
                  senderProfileId: "riley",
                  senderLabel: "Riley",
                  sessionKey: "agent:main:review",
                  agentId: "main",
                  sessionTitle: "Release review",
                  messageId: "message-review",
                  createdAt: notificationAt,
                  expiresAt: Date.now() + 60_000,
                  excerpt: "Can you review the release notes?",
                },
              ],
            },
            "mentions.dismiss": { gatewayInstanceId: "e2e-gateway-boot", revision: 2, items: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await waitForControlUiGatewayReady(page);
        await gateway.emitGatewayEvent("exec.approval.requested", {
          id: "approval-pending",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          request: { command: "pnpm test:changed", agentId: "main", sessionKey: "agent:main:main" },
        });
        if (width < 600) {
          await page.getByRole("button", { name: "Expand sidebar" }).click();
        }
        await page.locator(".sidebar-issues-button:visible").click();
        const panel = page.locator("#sidebar-issues-panel");
        const automation = panel.locator('[data-attention-kind="cronFailed"]');
        const mention = panel.locator('[data-mention-id="mention-review"]');
        const update = panel.locator('[data-attention-kind="updateAvailable"]');
        const approval = panel.locator('[data-approval-id="approval-pending"]');
        for (const item of [automation, mention, update, approval]) {
          await item.waitFor();
        }
        expect(
          await mention
            .locator("summary .sidebar-issues-panel__entity, summary .sidebar-issues-panel__state")
            .allTextContents(),
        ).toEqual(["Release review", "Riley mentioned you"]);
        for (const notification of [mention, update]) {
          const summary = notification.locator("summary");
          const body = notification.locator(".sidebar-issues-panel__body");
          expect({
            open: await notification.locator("details").getAttribute("open"),
            time: await summary.locator(".sidebar-issues-panel__state-row time").isVisible(),
            chevron: await summary.locator(".sidebar-issues-panel__chevron").isVisible(),
            body: await body.isVisible(),
          }).toEqual({ open: null, time: true, chevron: true, body: false });
          await summary.click();
          await body.waitFor({ state: "visible" });
          if (notification === mention) {
            expect(await body.getByRole("link", { name: "Open", exact: true }).isVisible()).toBe(
              true,
            );
            expect(await body.textContent()).toContain("Can you review the release notes?");
          }
          await summary.click();
          await body.waitFor({ state: "hidden" });
        }
        for (const [item, name] of [
          [automation, "Dismiss Release digest"],
          [mention, "Dismiss Release review"],
        ] as const) {
          expect(
            (
              await item.getByRole("button", { name, exact: item === mention }).textContent()
            )?.trim(),
          ).toBe("");
        }
        expect(await panel.locator(".sidebar-issues-panel__dismiss-help").count()).toBe(0);
        await update.getByRole("button", { name: /^Dismiss .*OpenClaw updated/ }).click();
        await update.waitFor({ state: "hidden" });
        expect(await gateway.getRequests("update.run")).toHaveLength(0);

        // A scoped bulk action must not acknowledge another tab's mention.
        await panel.getByRole("tab", { name: /Automations/ }).click();
        await panel.getByRole("button", { name: "Dismiss shown", exact: true }).click();
        await expect.poll(() => automation.count()).toBe(0);
        expect(await gateway.getRequests("mentions.dismiss")).toHaveLength(0);
        await panel.getByRole("tab", { name: /All/ }).click();
        await mention.waitFor();
        await panel.getByRole("button", { name: "Dismiss shown", exact: true }).click();
        await expect.poll(() => mention.count()).toBe(0);
        expect(
          (await gateway.getRequests("mentions.dismiss")).map((request) => request.params),
        ).toEqual([{ ids: ["mention-review"] }]);
        expect(await approval.count()).toBe(1);
        for (const method of ["exec.approval.resolve", "cron.update", "chat.abort"]) {
          expect(await gateway.getRequests(method), method).toHaveLength(0);
        }
      },
    );
  });
});
