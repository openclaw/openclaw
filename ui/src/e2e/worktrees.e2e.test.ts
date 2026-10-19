// Control UI tests cover Worktrees mutation failures through the rendered settings page.
import path from "node:path";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Worktrees mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const restorableWorktree = {
  baseRef: "main",
  branch: "openclaw/test",
  createdAt: 1,
  id: "worktree-1",
  lastActiveAt: 2,
  name: "restorable-test",
  ownerKind: "manual",
  path: "/tmp/repo/.worktrees/restorable-test",
  removedAt: 3,
  repoFingerprint: "0123456789abcdef",
  repoRoot: "/tmp/repo",
  snapshotRef: "refs/openclaw/worktree-snapshots/test",
};

suite.define(() => {
  it.each([1440, 390])(
    "keeps the Worktrees title above left-aligned hub tabs at %ipx",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: { "worktrees.list": { worktrees: [] } },
        });
        await page.goto(`${suite.server.baseUrl}worktrees`);
        await evaluateControlUiContext(page, (context) => context.theme.setMode("dark"));
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
        const heading = page.getByRole("heading", { name: "Worktrees", level: 1 });
        const tabs = page.getByRole("tablist", { name: "Session sections" });
        expect(await heading.isVisible()).toBe(true);
        expect(await tabs.isVisible()).toBe(true);
        const titleBox = await heading.boundingBox();
        const tabsBox = await tabs.boundingBox();
        expect(titleBox).not.toBeNull();
        expect(tabsBox).not.toBeNull();
        expect(tabsBox!.y).toBeGreaterThan(titleBox!.y + titleBox!.height);
        expect(Math.abs(tabsBox!.x - titleBox!.x)).toBeLessThan(12);
        await page.screenshot({
          path: path.join(suite.artifactDir, `worktrees-header-dark-${width}.png`),
        });
        await page.getByRole("tab", { name: "Sessions", exact: true }).click();
        await page.getByRole("heading", { name: "Sessions", level: 1 }).waitFor();
        expect(await page.locator(".page-subtitle").textContent()).toContain(
          "Active sessions and defaults.",
        );
        await page.getByRole("tab", { name: "Worktrees", exact: true }).click();
        await heading.waitFor();
        expect(await page.locator(".page-subtitle").textContent()).toContain(
          "Isolated agent task checkouts and recovery snapshots.",
        );
      });
    },
  );

  it("uses the remote default until a base branch is explicitly selected", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        workspace: "/synthetic/repo",
        workspaceGit: true,
        methodResponses: {
          "worktrees.list": { worktrees: [] },
          "worktrees.branches": {
            branches: [{ name: "main", kind: "local" }],
            defaultBranch: "main",
            headBranch: "old-feature",
          },
          "worktrees.create": { ...restorableWorktree, removedAt: undefined },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/worktrees`);
      await page.getByRole("button", { name: "New worktree", exact: true }).click();
      await gateway.waitForRequest("worktrees.branches");
      const base = page.getByLabel("Base branch", { exact: true });
      await page
        .locator('#worktrees-create-branches option[value="main"]')
        .waitFor({ state: "attached" });
      await page.screenshot({ path: path.join(suite.artifactDir, "default-base.png") });
      expect(await base.inputValue()).toBe("");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      expect((await gateway.waitForRequest("worktrees.create")).params).toEqual({
        repoRoot: "/synthetic/repo",
      });

      await page.getByRole("button", { name: "New worktree", exact: true }).click();
      await base.fill("main");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await base.waitFor({ state: "hidden" });
      expect(await gateway.getRequests("worktrees.create")).toHaveLength(2);
      expect((await gateway.getRequests("worktrees.create"))[1]?.params).toEqual({
        repoRoot: "/synthetic/repo",
        baseRef: "main",
      });

      await page.getByRole("button", { name: "New worktree", exact: true }).click();
      await base.fill("");
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await base.waitFor({ state: "hidden" });
      expect(await gateway.getRequests("worktrees.create")).toHaveLength(3);
      expect((await gateway.getRequests("worktrees.create"))[2]?.params).toEqual({
        repoRoot: "/synthetic/repo",
      });
    });
  });

  it("keeps a restore failure visible after the automatic list refresh succeeds", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["worktrees.restore"],
        methodResponses: {
          "worktrees.list": { worktrees: [restorableWorktree] },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/worktrees`);
      expect(response?.status()).toBe(200);
      await page.getByRole("button", { name: "Restore" }).click();
      await gateway.waitForRequest("worktrees.restore");
      await gateway.rejectDeferred("worktrees.restore", {
        message: "source repository is unavailable",
      });

      await expect
        .poll(async () => (await gateway.getRequests("worktrees.list")).length)
        .toBeGreaterThanOrEqual(2);
      await expect(page.locator(".callout.danger").textContent()).resolves.toContain(
        "source repository is unavailable",
      );
      await expect(page.getByRole("alert").count()).resolves.toBe(1);
      await expect(page.getByRole("button", { name: "Restore" }).count()).resolves.toBe(1);
    });
  });
});
