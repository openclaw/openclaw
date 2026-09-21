import path from "node:path";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { compactCronJobFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Inbox dismissal clarity" });
const failedJob: CronJob = {
  id: "release-digest",
  agentId: "main",
  name: "Release digest",
  enabled: true,
  createdAtMs: 0,
  updatedAtMs: 0,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Synthetic digest" },
  state: { lastRunStatus: "error", lastError: "Provider request failed" },
};

suite.define(() => {
  it.each([1280, 390])("dismisses notifications, not approvals or work, at %ipx", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 900 }, colorScheme: "dark", locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          presenceUsers: [
            { self: true, id: "alex", name: "Alex", identity: { type: "profile", id: "alex" } },
          ],
          featureMethods: [...defaultControlUiFeatureMethods, "mentions.list", "mentions.dismiss"],
          methodResponses: {
            "models.authStatus": { providers: [], ts: 1 },
            "cron.list": {
              jobs: [compactCronJobFixture(failedJob)],
              snapshotRevision: "dismissal-fixture",
              total: 1,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
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
                  createdAt: Date.now(),
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
        const approval = panel.locator('[data-approval-id="approval-pending"]');
        await automation.waitFor();
        await mention.waitFor();
        await approval.waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, `inbox-${width}.png`),
            animations: "disabled",
          });
        }
        expect(
          (
            await automation.getByRole("button", { name: "Dismiss Release digest" }).textContent()
          )?.trim(),
        ).toBe("");
        expect(
          (
            await mention.getByRole("button", { name: "Dismiss", exact: true }).textContent()
          )?.trim(),
        ).toBe("Dismiss");
        expect(await panel.locator(".sidebar-issues-panel__dismiss-help").count()).toBe(0);

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
        expect(await gateway.getRequests("exec.approval.resolve")).toHaveLength(0);
        expect(await gateway.getRequests("cron.update")).toHaveLength(0);
        expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
      },
    );
  });
});
