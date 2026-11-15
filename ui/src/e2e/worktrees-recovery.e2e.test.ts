import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { WorktreeRecord } from "../../../packages/gateway-protocol/src/schema/worktrees.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
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
      const frame = await takeControlUiScreenshotFrame(
        page,
        page.locator("openclaw-worktrees-page"),
        [alert, restore],
        { animations: "disabled" },
      );
      const screenshot = path.join(
        suite.artifactDir,
        process.env.WORKTREE_PROOF_STAGE === "after" ? "after.png" : "before.png",
      );
      await writeFile(screenshot, frame.png);
      console.log("Worktrees recovery screenshot:", screenshot);
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

  it("preserves create drafts, destructive confirmations and cleanup outcomes", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const active = { ...record, removedAt: undefined };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "worktrees.list": { worktrees: [] },
          "worktrees.branches": { branches: [{ name: "main", kind: "local" }] },
          "worktrees.create": {
            __mockError: { code: "UNAVAILABLE", message: "Creation unavailable" },
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}worktrees`);
      await page.getByText("No managed worktrees.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "New worktree", exact: true }).click();
      await page.getByRole("textbox", { name: "Repository", exact: true }).fill("/synthetic/repo");
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("recovery-task");
      await page.getByRole("combobox", { name: "Base branch", exact: true }).fill("main");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "Creation unavailable" }).waitFor();
      expect(await page.getByRole("textbox", { name: "Name", exact: true }).inputValue()).toBe(
        "recovery-task",
      );
      expect(
        await page.getByRole("combobox", { name: "Base branch", exact: true }).inputValue(),
      ).toBe("main");
      expect(await page.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
      await gateway.setMethodResponse("worktrees.create", active);
      await gateway.setMethodResponse("worktrees.list", { worktrees: [active] });
      await page.getByRole("button", { name: "Create", exact: true }).click();
      const deleteRow = page.getByRole("button", { name: "Delete: recovery-task", exact: true });
      await deleteRow.waitFor();
      const creates = await gateway.getRequests("worktrees.create");
      expect(creates.map((request) => request.params)).toEqual([
        { repoRoot: "/synthetic/repo", name: "recovery-task", baseRef: "main" },
        { repoRoot: "/synthetic/repo", name: "recovery-task", baseRef: "main" },
      ]);
      expect(await page.getByRole("textbox", { name: "Name", exact: true }).count()).toBe(0);
      const dialog = page.locator(".confirm-dialog");
      await deleteRow.click();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(await gateway.getRequests("worktrees.remove")).toHaveLength(0);
      await gateway.setMethodResponse("worktrees.remove", {
        removed: false,
        snapshotError: "Snapshot storage unavailable",
      });
      await deleteRow.click();
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await dialog.getByText("Delete without a snapshot?", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      const warning = page.getByRole("alert").filter({ hasText: "Snapshot storage unavailable" });
      await warning.waitFor();
      expect(await gateway.getRequests("worktrees.remove")).toHaveLength(1);
      expect(await deleteRow.isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
      await deleteRow.click();
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await dialog.getByText("Delete without a snapshot?", { exact: true }).waitFor();
      await gateway.setMethodResponse("worktrees.remove", {
        removed: true,
        snapshotError: "Snapshot storage unavailable",
      });
      await gateway.setMethodResponse("worktrees.list", { worktrees: [record] });
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("button", { name: "Restore: recovery-task", exact: true }).waitFor();
      expect(
        (await gateway.getRequests("worktrees.remove")).map((request) => request.params),
      ).toEqual([{ id: record.id }, { id: record.id }, { id: record.id, force: true }]);
      await warning.waitFor();
      const gc = { removed: [], orphansDeleted: 0, snapshotsPruned: 0, jobId: "cleanup-proof" };
      await gateway.setMethodResponse("worktrees.gc", {
        sequence: [
          { ...gc, state: "queued" },
          {
            ...gc,
            state: "completed",
            outcome: "partial",
            error: "Cleanup retained a busy worktree",
          },
        ],
      });
      await page.getByRole("button", { name: "Clean up now", exact: true }).click();
      await page.getByRole("button", { name: "Loading…", exact: true }).waitFor();
      await page
        .getByRole("alert")
        .filter({ hasText: "Cleanup retained a busy worktree" })
        .waitFor();
      expect((await gateway.getRequests("worktrees.gc")).map((request) => request.params)).toEqual([
        {},
        { jobId: "cleanup-proof" },
      ]);
      expect(
        await page.getByRole("button", { name: "Clean up now", exact: true }).isEnabled(),
      ).toBe(true);
      expect(await page.getByRole("button", { name: "Retry", exact: true }).count()).toBe(0);
    });
  });
});
