import path from "node:path";
import { expect, it } from "vitest";
import type { ExecApprovalStandingGrant } from "../../../packages/gateway-protocol/src/schema/exec-approvals.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Standing grants independent of approval history",
  startServerBeforeBrowser: true,
});
const grant: ExecApprovalStandingGrant = {
  grantId: "grant-independent",
  mintedByApprovalId: "approval-independent",
  agentId: "main",
  cronJobId: "job-independent",
  cronJobName: "Synthetic daily report",
  command: "echo synthetic-report",
  cwd: null,
  createdAtMs: 1_000,
  expiresAtMs: null,
  revokedAtMs: null,
  revokedBy: null,
  lastUsedAtMs: null,
  useCount: 3,
};
suite.define(() => {
  it.each([700, 769, 820, 900, 901, 1100, 1280])(
    "keeps both tables inside the page at %ipx",
    async (width) => {
      const sessionKey = "agent:main:telegram:group:release-coordination-and-rollout-review";
      const history = {
        id: "approval-long",
        status: "denied",
        presentation: {
          kind: "exec",
          commandText:
            "pnpm --filter ./packages/synthetic-long-package-name-without-breaks run build",
          allowedDecisions: ["deny"],
        },
        urlPath: "/approve/approval-long",
        createdAtMs: 1_000,
        expiresAtMs: 61_000,
        resolvedAtMs: 2_000,
        decision: "deny",
        reason: "user",
        source: { agentId: "main", sessionKey },
        resolver: { kind: "device", id: "reviewer-device" },
      };
      await suite.withPage(
        { viewport: { width, height: 900 }, locale: "en-US", reducedMotion: "reduce" },
        async ({ page }) => {
          await installMockGateway(page, {
            methodResponses: {
              "approval.history": { items: [history] },
              "exec.approval.grants.list": {
                grants: [
                  { ...grant, command: `tar -czf /var/backups/${"workspace-".repeat(8)}.tgz` },
                ],
              },
            },
          });
          await page.goto(new URL("settings/approvals", suite.server.baseUrl).href);
          await page
            .locator(".approval-history-table")
            .getByText(sessionKey, { exact: false })
            .waitFor();
          await page.locator(".standing-grants-table").getByText(grant.cronJobName!).waitFor();
          const overflow = await page.evaluate(() =>
            [...document.querySelectorAll(".data-table-container")].map(
              (container) => container.scrollWidth - container.clientWidth,
            ),
          );
          expect(overflow).toEqual([0, 0]);
        },
      );
    },
  );

  it("keeps standing grants revocable when history fails", async () => {
    await suite.withPage(
      { viewport: { width: 1200, height: 900 }, locale: "en-US", reducedMotion: "reduce" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          deferredMethods: ["approval.history"],
          methodResponses: {
            "exec.approval.grants.list": { grants: [grant] },
            "exec.approval.grants.revoke": { outcome: "revoked" },
          },
        });
        await page.goto(new URL("settings/approvals", suite.server.baseUrl).href);
        await gateway.waitForRequest("approval.history");
        await gateway.rejectDeferred("approval.history", {
          code: "UNAVAILABLE",
          message: "Synthetic history unavailable",
        });
        await page
          .getByRole("alert")
          .filter({ hasText: "Synthetic history unavailable" })
          .waitFor();
        await page.screenshot({
          path: path.join(suite.artifactDir, "ui-operations-oct25-afternoon-history-failed.png"),
          animations: "disabled",
        });
        await expect.poll(() => gateway.getRequests("exec.approval.grants.list")).toHaveLength(1);
        const grants = page.locator(".standing-grants-table");
        await grants.getByText(grant.cronJobName!, { exact: true }).waitFor();
        await grants.getByRole("button", { name: /Revoke/ }).click();
        await expect.poll(() => gateway.getRequests("exec.approval.grants.revoke")).toHaveLength(1);
        expect((await gateway.getRequests("exec.approval.grants.revoke"))[0]?.params).toEqual({
          grantId: grant.grantId,
        });
        await grants.getByText("Revoked", { exact: true }).waitFor();
        await expect.poll(() => grants.getByRole("button").count()).toBe(0);
      },
    );
  });
});
