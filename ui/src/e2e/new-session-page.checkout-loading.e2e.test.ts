import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { observeLayoutShifts } from "../test-helpers/control-ui-layout-shift.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
  WORKSPACE,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([400, 820, 1280])("holds checkout geometry during discovery at %i px", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 900 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          workspace: WORKSPACE,
          operatorScopes: ["operator.read", "operator.sessions.write"],
          featureMethods: ["projects.list", "projects.checkoutOptions", "sessions.create"],
          methodResponses: {
            "projects.list": {
              projects: [
                { id: "sample-project", displayName: "Sample Project", source: "registered" },
              ],
            },
            "projects.checkoutOptions": { current: false, worktree: true },
          },
        });
        await page.goto(suite.server.baseUrl + "new");
        const project = page.locator("#new-session-project-trigger");
        await project.click();
        await gateway.deferNext("projects.checkoutOptions");
        await page
          .locator(".new-session-page__project-popover")
          .getByRole("button", { name: "Sample Project", exact: true })
          .click();
        await gateway.waitForRequest("projects.checkoutOptions");
        await page.mouse.move(0, 0);
        const checkout = page.locator("#new-session-checkout-trigger");
        const skeleton = page.locator(".new-session-page__checkout-skeleton");
        const tray = page.locator(".new-session-page__context-tray");
        const message = page.locator(".new-session-page__message");
        expect(await checkout.count()).toBe(0);
        await waitForLayoutSettled(page, ".new-session-page__context-tray button");
        const before = {
          tray: await tray.boundingBox(),
          project: await project.boundingBox(),
          message: await message.boundingBox(),
        };
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(page, tray, [project], {
            animations: "disabled",
          });
          await writeFile(
            path.join(suite.artifactDir, "checkout-" + width + "-checking.png"),
            frame.png,
          );
        }
        expect(await skeleton.isVisible()).toBe(width <= 768);
        const pendingIcon =
          width <= 768
            ? await skeleton.locator(".new-session-page__target-icon svg").boundingBox()
            : null;
        const pendingLabel =
          width <= 768
            ? await skeleton.locator(".new-session-page__skeleton-bar").boundingBox()
            : null;
        if (width <= 768) {
          expect(pendingIcon).not.toBeNull();
          expect(await skeleton.locator(".new-session-page__picker-chevron").count()).toBe(0);
        }
        const shifts = await observeLayoutShifts(page);
        await gateway.resolveDeferred("projects.checkoutOptions", {
          current: false,
          worktree: true,
        });
        await checkout.getByText("New worktree", { exact: true }).waitFor();
        await waitForLayoutSettled(page, ".new-session-page__context-tray button");
        expect(await skeleton.count()).toBe(0);
        const after = {
          tray: await tray.boundingBox(),
          project: await project.boundingBox(),
          message: await message.boundingBox(),
        };
        expect(after).toEqual(before);
        if (pendingIcon && pendingLabel) {
          expect(
            await checkout.locator(".new-session-page__target-icon svg").boundingBox(),
          ).toEqual(pendingIcon);
          expect(
            (await checkout.locator(".new-session-page__trigger-label").boundingBox())?.x,
          ).toBe(pendingLabel.x);
          expect(await checkout.locator(".new-session-page__picker-chevron").isVisible()).toBe(
            true,
          );
        }
        const observed = await shifts.evaluate((observer) => observer.read());
        // Count even recent-input shifts: the same reply may arrive after the input window.
        expect(observed.entries.reduce((sum, entry) => sum + entry.value, 0)).toBe(0);
        await shifts.evaluate((observer) => observer.stop());
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(page, tray, [project, checkout], {
            animations: "disabled",
          });
          await writeFile(
            path.join(suite.artifactDir, "checkout-" + width + "-ready.png"),
            frame.png,
          );
        }
      },
    );
  });

  it("shows an eligible project checkout without waiting for branch suggestions", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: false,
        featureMethods: [
          "projects.list",
          "projects.checkoutOptions",
          "worktrees.branches",
          "sessions.create",
        ],
        methodResponses: {
          "projects.list": {
            projects: [
              {
                id: "sample-project",
                displayName: "Sample Project",
                source: "registered",
                repoRoot: "/sample/project",
              },
            ],
          },
          "projects.checkoutOptions": { current: false, worktree: true },
          "worktrees.branches": { branches: [], refreshing: true },
        },
      });
      await page.goto(suite.server.baseUrl + "new");
      await page.locator("#new-session-project-trigger").click();
      await page
        .locator(".new-session-page__project-popover")
        .getByRole("button", { name: "Sample Project", exact: true })
        .click();
      await gateway.waitForRequest("worktrees.branches");
      await page.locator(".new-session-page__message").fill("Use the confirmed checkout");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isEnabled())
        .toBe(true);
      const checkout = page.locator("#new-session-checkout-trigger");
      expect(await checkout.isVisible()).toBe(true);
      expect(await checkout.textContent()).toContain("New worktree");
      await checkout.click();
      const picker = page.locator(".new-session-page__checkout-popover");
      await picker.getByText("Refreshing…", { exact: true }).waitFor();
      const name = picker.locator("[data-worktree-name]");
      await name.fill("my-task");
      await gateway.setMethodResponse("worktrees.branches", {
        branches: [],
        repositoryStatus: "git",
      });
      await gateway.emitGatewayEvent("worktrees.branches.changed", { repoRoot: "/sample/project" });
      await picker.getByText("Refreshing…", { exact: true }).waitFor({ state: "hidden" });
      expect(await name.inputValue()).toBe("my-task");
    });
  });
});
