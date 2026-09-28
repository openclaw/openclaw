import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  captureNewSessionComposerUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
  waitForGatewayRecoveryScope,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([1, 2])("stacks phone setup selectors with %s agents", async (agentCount) => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, hasTouch: true },
      async ({ page }) => {
        await installMockGateway(page, {
          workspace: "/workspace/openclaw",
          workspaceGit: true,
          featureMethods: ["projects.list", "sessions.create", "worktrees.branches"],
          methodResponses: {
            "agents.list": {
              agents: [
                {
                  id: "main",
                  name: "Roboclaw",
                  workspace: "/workspace/openclaw",
                  workspaceGit: true,
                },
                {
                  id: "research",
                  name: "Research",
                  workspace: "/workspace/research",
                  workspaceGit: true,
                },
              ].slice(0, agentCount),
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            "worktrees.branches": {
              branches: [{ kind: "local", name: "main" }],
              defaultBranch: "main",
              headBranch: "main",
              repositoryStatus: "git",
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        const checkout = page.locator("#new-session-checkout-trigger");
        await checkout.click();
        await page
          .getByRole("button", { name: "New worktree Isolated copy of the repo", exact: true })
          .click();
        await page.keyboard.press("Escape");
        await expect.poll(() => checkout.getAttribute("data-worktree")).toBe("true");
        const selectors = page.locator(
          ".new-session-page__triggers .agent-select__trigger, .new-session-page__triggers > span > .new-session-page__trigger",
        );
        await expect.poll(() => selectors.count()).toBe(agentCount + 2);
        await page.evaluate(() => document.fonts.ready);
        for (const { width, mobile } of [
          { width: 390, mobile: true },
          { width: 320, mobile: true },
          { width: 430, mobile: true },
          { width: 560, mobile: true },
          { width: 1280, mobile: false },
        ]) {
          await page.setViewportSize({ width, height: 900 });
          await page
            .locator(mobile ? ".shell--mobile-nav" : ".shell:not(.shell--mobile-nav)")
            .waitFor();
          await selectors.first().click({ trial: true });
          // Measure only after the shell mode, controls, and container layout settle.
          await waitForLayoutSettled(page, ".new-session-page__triggers button");
          await captureNewSessionComposerUiProof(suite, page, `mobile-setup-${width}.png`);
          const layout = await selectors.evaluateAll((buttons) =>
            buttons.map((button) => {
              const box = button.getBoundingClientRect();
              // Flex/grid aligns the wrapper; inline button baselines can differ within one row.
              const item = button.closest(".new-session-page__select")!.getBoundingClientRect();
              return {
                row: Math.round(item.top + item.height / 2),
                left: box.left,
                right: box.right,
                height: box.height,
              };
            }),
          );
          expect(new Set(layout.map((box) => box.row)).size).toBe(width <= 560 ? layout.length : 1);
          for (const [index, box] of layout.entries()) {
            expect(box.left).toBeGreaterThanOrEqual(0);
            expect(box.right).toBeLessThanOrEqual(width);
            expect(box.height).toBeGreaterThanOrEqual(width <= 560 ? 44 : 26);
            const next = layout[index + 1];
            if (next && box.row === next.row) {
              expect(box.right).toBeLessThanOrEqual(next.left);
            }
          }
        }
        await page.setViewportSize({ width: 320, height: 700 });
        await checkout.click();
        const baseRef = page.locator("#new-session-worktree-base-ref");
        await baseRef.fill("feature/mobile-layout-with-a-long-branch-name");
        await page.keyboard.press("Escape");
        await expect
          .poll(() => checkout.textContent())
          .toContain("feature/mobile-layout-with-a-long-branch-name");
        const triggerRow = page.locator(".new-session-page__triggers");
        expect(
          await triggerRow.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        await captureNewSessionComposerUiProof(suite, page, "mobile-setup-long-branch.png");
      },
    );
  });

  it("keeps empty-state suggestions desktop-only across viewport changes", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": {
            count: 0,
            defaults: { contextTokens: null, model: null, modelProvider: null },
            path: "",
            sessions: [],
            ts: Date.now(),
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      const suggestions = page.locator(".agent-chat__suggestion:visible");
      await expect.poll(() => suggestions.count()).toBe(4);

      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(() => suggestions.count()).toBe(0);

      await page.setViewportSize({ width: 1280, height: 900 });
      await expect.poll(() => suggestions.count()).toBe(4);
    });
  });

  it("keeps recent sessions visible on phone layouts", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": {
            count: 1,
            defaults: { contextTokens: null, model: null, modelProvider: null },
            path: "",
            sessions: [
              {
                key: "agent:main:dashboard:recent",
                kind: "direct",
                label: "Recent work",
                updatedAt: Date.now(),
              },
            ],
            ts: Date.now(),
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      await expect.poll(() => page.locator(".agent-chat__recent").count()).toBe(1);
      await expect.poll(() => page.locator(".agent-chat__recent").isVisible()).toBe(true);
    });
  });

  it("keeps selected people and their remove control compact on a cold New Session", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        presenceUsers: [
          {
            self: true,
            id: "profile-alice",
            identity: { type: "profile", id: "profile-alice" },
            name: "Alice",
          },
        ],
        methodResponses: {
          "users.mentionable": {
            users: [{ profileId: "profile-bob", displayName: "Bob", online: true }],
            truncated: false,
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      await waitForControlUiRoute(page, { pathname: "/new", routeId: "new-session" });
      await waitForGatewayRecoveryScope(page);
      const textarea = page.locator(".new-session-page__message");
      await textarea.pressSequentially("@Bob");
      expect((await gateway.waitForRequest("users.mentionable")).params).toMatchObject({
        agentId: "main",
      });
      await page.getByRole("option", { name: /Bob/ }).click();
      const preview = page.locator(".new-session-page__composer .chat-reply-preview");
      await expect.poll(() => preview.textContent()).toContain("Will notify");
      await expect
        .poll(() => preview.locator(".composer-context-strip__person-name").textContent())
        .toBe("Bob");
      const remove = preview.getByRole("button", { name: "Remove mention" });

      for (const viewport of [
        { width: 1280, height: 900 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        await captureNewSessionComposerUiProof(
          suite,
          page,
          `cold-mention-selection-${viewport.width}.png`,
        );
        const layout = await preview.evaluate((element) => {
          const bar = element.getBoundingClientRect();
          const text = element
            .querySelector(".composer-context-strip__people")!
            .getBoundingClientRect();
          const button = element.querySelector("button")!.getBoundingClientRect();
          return {
            height: bar.height,
            textBeforeButton: text.right <= button.left,
            sameRow: Math.abs(text.top + text.height / 2 - button.top - button.height / 2) <= 1,
            buttonContained:
              button.left >= bar.left &&
              button.right <= bar.right &&
              button.top >= bar.top &&
              button.bottom <= bar.bottom,
            iconSizes: [...element.querySelectorAll("svg")].map((icon) => {
              const bounds = icon.getBoundingClientRect();
              return Math.max(bounds.width, bounds.height);
            }),
          };
        });
        expect(layout.height).toBeLessThanOrEqual(48);
        expect(layout).toMatchObject({
          textBeforeButton: true,
          sameRow: true,
          buttonContained: true,
        });
        for (const size of layout.iconSizes) {
          expect(size).toBeGreaterThan(0);
          expect(size).toBeLessThanOrEqual(24);
        }
        await expect.poll(() => remove.isVisible()).toBe(true);
      }

      await remove.click();
      await expect.poll(() => preview.count()).toBe(0);
      expect(await textarea.inputValue()).toBe("@Bob ");
      await captureNewSessionComposerUiProof(suite, page, "cold-mention-removed.png");
    });
  });
});
