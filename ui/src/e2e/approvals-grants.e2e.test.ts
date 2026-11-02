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
  it.each([320, 390, 820, 1100, 1440])("shows grants as rows at %ipx", async (width) => {
    const command = `tar -czf /var/backups/${"workspace-".repeat(12)}.tgz ./workspace`;
    await suite.withPage(
      { viewport: { width, height: 900 }, locale: "en-US", reducedMotion: "reduce" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "approval.history": { items: [] },
            "exec.approval.grants.list": {
              grants: [
                { ...grant, command },
                { ...grant, grantId: "grant-revoked", revokedAtMs: 2_000, revokedBy: "operator" },
                { ...grant, grantId: "grant-expired", expiresAtMs: 2_000 },
              ],
            },
            "exec.approval.grants.revoke": { outcome: "revoked" },
          },
        });
        await page.goto(new URL("settings/approvals", suite.server.baseUrl).href);
        const grants = page.getByRole("list", { name: "Standing grants" });
        for (const state of ["Until revoked", "Revoked", "Expired"]) {
          await grants.getByText(state, { exact: true }).waitFor();
        }
        await grants.getByText(command, { exact: true }).waitFor();
        expect(await grants.evaluate((list) => list.scrollWidth - list.clientWidth)).toBe(0);
        const revoke = grants.getByRole("button", { name: /Revoke/ });
        const [row, button] = await Promise.all([
          grants.getByRole("listitem").first().boundingBox(),
          revoke.boundingBox(),
        ]);
        expect(button!.x + button!.width).toBeGreaterThan(row!.x + row!.width - 24);
        await revoke.click();
        await expect.poll(() => gateway.getRequests("exec.approval.grants.revoke")).toHaveLength(1);
        await expect.poll(() => grants.getByRole("button").count()).toBe(0);
      },
    );
  });

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
        const grants = page.locator(".standing-grants");
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
