import { expect, it } from "vitest";
import type { WorktreeRecord } from "../../../packages/gateway-protocol/src/schema/worktrees.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Worktrees recovery" });
const record: WorktreeRecord = {
  id: "worktree-proof",
  name: "recovery-task",
  repoFingerprint: "0123456789abcdef",
  repoRoot: "/synthetic/repo",
  path: "/synthetic/worktrees/recovery-task",
  branch: "task/recovery",
  baseRef: "main",
  ownerKind: "manual",
  createdAt: 1_794_700_000_000,
  lastActiveAt: 1_794_700_000_000,
  removedAt: 1_794_700_100_000,
  snapshotRef: "refs/openclaw/snapshots/worktree-proof",
};

suite.define(() => {
  it("retries a failed post-restore inventory read without repeating restoration", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "worktrees.list": { worktrees: [record] },
          "worktrees.restore": { ...record, removedAt: undefined },
        },
      });
      await page.goto(`${suite.server.baseUrl}worktrees`);
      const restore = page.getByRole("button", { name: "Restore: recovery-task", exact: true });
      await restore.waitFor({ state: "visible" });
      await gateway.setMethodResponse("worktrees.list", {
        __mockError: { code: "UNAVAILABLE", message: "Worktree inventory temporarily unavailable" },
      });
      await restore.click();
      await gateway.waitForRequest("worktrees.restore");
      const alert = page
        .getByRole("alert")
        .filter({ hasText: "Worktree inventory temporarily unavailable" });
      await alert.waitFor({ state: "visible" });
      const retry = page.getByRole("button", { name: "Retry", exact: true });
      expect(await retry.isVisible(), "failed refresh needs a read-only recovery action").toBe(
        true,
      );
      await gateway.setMethodResponse("worktrees.list", {
        worktrees: [{ ...record, removedAt: undefined }],
      });
      await gateway.deferNext("worktrees.list");
      await retry.click();
      await gateway.waitForRequest("worktrees.list", { after: 2 });
      expect(await restore.isVisible()).toBe(true);
      expect(await restore.isDisabled()).toBe(true);
      await gateway.resolveDeferred("worktrees.list");
      await page
        .getByRole("button", { name: "Delete: recovery-task", exact: true })
        .waitFor({ state: "visible" });
      expect(await gateway.getRequests("worktrees.restore")).toHaveLength(1);
      expect(await alert.count()).toBe(0);
    });
  });
});
