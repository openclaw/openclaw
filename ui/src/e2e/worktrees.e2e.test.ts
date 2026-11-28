import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { rasterizeProofAnnotations } from "../test-helpers/proof-annotations.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Worktrees mocked Gateway E2E",
  startServerBeforeBrowser: true,
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
};

suite.define(() => {
  it.each([1440, 390])("keeps the Worktrees title above left-aligned hub tabs at %ipx", (width) =>
    suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: { "worktrees.list": { worktrees: [] } },
      });
      await page.goto(`${suite.server.baseUrl}worktrees`);
      await evaluateControlUiContext(page, (context) => context.theme.setMode("dark"));
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");
      const title = await page.getByRole("heading", { name: "Worktrees", level: 1 }).boundingBox();
      const tabs = await page.getByRole("tablist", { name: "Session sections" }).boundingBox();
      expect(title).not.toBeNull();
      expect(tabs).not.toBeNull();
      expect(tabs!.y).toBeGreaterThan(title!.y + title!.height);
      const firstTab = await page
        .getByRole("tab", { name: "Sessions", exact: true })
        .evaluate((tab) => {
          const label = document.createRange();
          label.selectNodeContents(tab);
          const box = tab.getBoundingClientRect();
          return {
            labelLeft: label.getBoundingClientRect().left,
            leadingEdgeClickable: tab.contains(
              document.elementFromPoint(box.left + 1, box.top + box.height / 2),
            ),
          };
        });
      const readingEdge = await page
        .locator(".page-subtitle")
        .evaluate((text) => text.getBoundingClientRect().left);
      expect(Math.abs(firstTab.labelLeft - readingEdge)).toBeLessThanOrEqual(1);
      expect(firstTab.leadingEdgeClickable).toBe(true);
      for (const [name, subtitle] of [
        ["Sessions", "Active sessions and defaults."],
        ["Worktrees", "Isolated agent task checkouts and recovery snapshots."],
      ]) {
        await page.getByRole("tab", { name, exact: true }).click();
        await page.getByRole("heading", { name, level: 1 }).waitFor();
        expect(await page.locator(".page-subtitle").textContent()).toContain(subtitle);
      }
    }),
  );

  it.each([
    [390, 844],
    [820, 1180],
    [1180, 820],
    [1440, 900],
  ])(
    "distinguishes matching checkout names and returns focus when deletion is canceled at %i × %i",
    (width, height) =>
      suite.withPage(
        { viewport: { width, height }, hasTouch: true, reducedMotion: "reduce" },
        async ({ page }) => {
          const name = "regionalaccessibilityandinterpretationserviceintegrationreview01";
          // oxlint-disable-next-line oxc/no-map-spread -- each record must be an independent copy of the shared fixture.
          const records = ["/synthetic/team/project", "/synthetic/archive/project"].map(
            (repoRoot, index) => ({
              ...restorableWorktree,
              id: "worktree-" + index,
              repoFingerprint: "0123456789abcde" + index,
              removedAt: undefined,
              repoRoot,
              path: repoRoot + "/.worktrees/" + name,
              name,
              branch: "openclaw/" + name,
            }),
          );
          const gateway = await installMockGateway(page, {
            methodResponses: { "worktrees.list": { worktrees: records } },
          });
          await page.goto(suite.server.baseUrl + "worktrees");
          const buttons = page.getByRole("button", { name: "Delete: " + name, exact: true });
          await buttons.last().waitFor();
          expect(await buttons.count()).toBe(2);
          for (const [index, record] of records.entries()) {
            const row = page.locator("openclaw-worktrees-page .settings-row").filter({
              has: page.locator(`[aria-describedby="worktree-repository-${record.id}"]`),
            });
            const button = row.getByRole("button", { name: "Delete: " + name, exact: true });
            const details = row.locator(".worktree-row__details");
            const summary = details.locator("summary");
            expect(await summary.textContent()).toBe(
              index === 0 ? "team/project" : "archive/project",
            );
            expect(await row.locator(".worktree-row__name").getAttribute("title")).toBe(name);
            await summary.press("Enter");
            // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- innerText proves the opened text is rendered, not just present.
            expect(await details.innerText()).toContain(record.repoRoot);
            // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- innerText proves the opened text is rendered, not just present.
            expect(await details.innerText()).toContain(record.branch);
            await summary.press("Enter");
            expect
              .soft(
                await button.evaluate((node) => {
                  const id = node.getAttribute("aria-describedby");
                  return id ? document.getElementById(id)?.textContent : null;
                }),
              )
              .toBe(record.repoRoot);
            await button.focus();
            await button.press("Enter");
            const dialog = page.getByRole("dialog", { name: /Snapshot and delete/ });
            await dialog.waitFor();
            // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- innerText proves the opened text is rendered, not just present.
            expect.soft(await dialog.innerText()).toContain(record.path);
            for (const item of await dialog.locator("h2,.exec-approval-command").all()) {
              expect
                .soft(await item.evaluate((node) => node.scrollWidth <= node.clientWidth + 1))
                .toBe(true);
            }
            if (index === 0) {
              await dialog.getByRole("button", { name: "Cancel", exact: true }).tap();
            } else {
              await page.keyboard.press("Escape");
            }
            await dialog.waitFor({ state: "hidden" });
            expect.soft(await button.evaluate((node) => node.matches(":focus"))).toBe(true);
          }
          expect(await gateway.getRequests("worktrees.remove")).toHaveLength(0);
        },
      ),
  );

  it("uses the remote default until a base branch is explicitly selected", () =>
    suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const repoRoot = "/synthetic/repo";
      const gateway = await installMockGateway(page, {
        workspace: repoRoot,
        workspaceGit: true,
        methodResponses: {
          "worktrees.list": { worktrees: [] },
          "worktrees.branches": {
            branches: [{ name: "main", kind: "local" }],
            defaultBranch: "main",
            headBranch: "old-feature",
          },
          "worktrees.create": {},
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/worktrees`);
      const base = page.getByRole("button", { name: /^Base branch:/ });
      for (const value of [undefined, "main", "Automatic base"]) {
        await page.getByRole("button", { name: "New worktree", exact: true }).click();
        await base.click();
        if (value === undefined) {
          await page.getByRole("option", { name: "main", exact: true }).waitFor();
          await page.keyboard.press("Escape");
          expect(await base.textContent()).toContain("Automatic base");
        } else {
          await page.getByRole("option", { name: value, exact: true }).click();
        }
        await page.getByRole("button", { name: "Create", exact: true }).click();
        await base.waitFor({ state: "hidden" });
      }
      const requests = await gateway.getRequests("worktrees.create");
      expect(requests.map(({ params }) => params)).toEqual([
        { repoRoot },
        { repoRoot, baseRef: "main" },
        { repoRoot },
      ]);
    }));

  it("requires an explicit safe retry for preserved removal", () =>
    suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const cleanup = {
        state: "preserved",
        reason: "Nested repository preserved. Repair the checkout before retrying.",
        attempts: 1,
        nextAttemptAt: null,
      };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "worktrees.list": {
            worktrees: [{ ...restorableWorktree, removedAt: undefined, cleanup }],
          },
          "worktrees.remove": { removed: false, preserved: cleanup },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/worktrees`);
      await page.getByRole("button", { name: "Delete: restorable-test", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await gateway.waitForRequest("worktrees.remove");
      await dialog.getByRole("heading", { name: "Retry", exact: true }).waitFor();
      const action = dialog.getByRole("button", { name: /^(Delete|Retry)$/ });
      const frame = await takeControlUiScreenshotFrame(page, dialog, [action], {
        elements: [action],
        animations: "disabled",
      });
      await writeFile(path.join(suite.artifactDir, "preserved-remove.png"), frame.png);
      await writeFile(
        path.join(suite.artifactDir, "preserved-remove-annotated.png"),
        await rasterizeProofAnnotations(suite.browser, {
          viewport: page.viewportSize()!,
          scale: await page.evaluate(() => window.devicePixelRatio),
          image: frame.png,
          annotations: [
            {
              kind: "outline",
              rect: frame.elements[0]!.bounds,
              text:
                (await action.textContent()) === "Retry"
                  ? "Explicit retry keeps snapshot safety"
                  : "Incorrect force-delete prompt",
              labelAt: { x: 680, y: 610 },
              color: "#E57373",
            },
          ],
        }),
      );
      expect(await dialog.textContent()).toContain(cleanup.reason);
      await dialog.getByRole("button", { name: "Retry", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("worktrees.remove")).length).toBe(2);
      expect((await gateway.getRequests("worktrees.remove")).map(({ params }) => params)).toEqual([
        { id: "worktree-1" },
        { id: "worktree-1", retryPreserved: true },
      ]);
      await expect
        .poll(() => page.locator(".callout.danger").textContent())
        .toContain(cleanup.reason);
    }));

  it("keeps a restore failure visible after the automatic list refresh succeeds", () =>
    suite.withPage(undefined, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["worktrees.restore"],
        methodResponses: {
          "worktrees.list": { worktrees: [restorableWorktree] },
        },
      });
      const response = await page.goto(`${suite.server.baseUrl}settings/worktrees`);
      expect(response?.status()).toBe(200);
      const error = { message: "source repository is unavailable" };
      await page.getByRole("button", { name: "Restore" }).click();
      await gateway.waitForRequest("worktrees.restore");
      await gateway.rejectDeferred("worktrees.restore", error);
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.list")).length)
        .toBeGreaterThanOrEqual(2);
      await expect(page.locator(".callout.danger").textContent()).resolves.toContain(error.message);
      await expect(page.getByRole("alert").count()).resolves.toBe(1);
      await expect(page.getByRole("button", { name: "Restore" }).count()).resolves.toBe(1);
    }));
});
