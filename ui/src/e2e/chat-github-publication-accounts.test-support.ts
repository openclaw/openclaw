import type { BrowserContext, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../../src/gateway/control-ui-contract.js";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { openChatDetails, openChatPublication } from "./chat-details.test-support.ts";
import { exactButton as publicationAction } from "./chat-flow.test-support.ts";
import {
  publicationMethods,
  publicationOptions,
  showPublicationBranch,
} from "./chat-github-publication.test-support.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export { publicationAction };

export async function selectPublicationAccount(root: Page | Locator, source: string) {
  const mobile = root.getByRole("button", { name: /^Publication account(?:$|:)/ });
  const trigger = (await mobile.count())
    ? mobile
    : root.locator(".chat-environment__branch .chat-pr__actions-trigger");
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  await root
    .locator(
      `.chat-pr-branch-menu [role="menuitemradio"][value="${source}"], .github-publication-mobile__accounts-panel [role="menuitemradio"][value="${source}"]`,
    )
    .click();
}

export function installPublicationGateway(
  page: Page,
  options: NonNullable<Parameters<typeof installMockGateway>[1]> = {},
) {
  return installMockGateway(page, {
    operatorScopes: ["operator.read", "operator.write"],
    featureMethods: publicationMethods,
    ...options,
    methodResponses: {
      [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
      "sessions.github.options": publicationOptions,
      ...options.methodResponses,
    },
  });
}

export function defineGitHubPublicationAccountTests({
  suite,
  newPublicationContext,
}: {
  suite: ReturnType<typeof createControlUiE2eSuite>;
  newPublicationContext: () => Promise<BrowserContext>;
}) {
  async function openPublication(
    options: Parameters<typeof installPublicationGateway>[1] = {},
    width?: number,
  ) {
    const page = await (await newPublicationContext()).newPage();
    if (width) {
      await page.setViewportSize({ width, height: 800 });
    }
    const gateway = await installPublicationGateway(page, options);
    await page.goto(`${suite.server.baseUrl}chat`);
    await showPublicationBranch(gateway);
    return { page, gateway };
  }

  it.each([1180, 390])(
    "keeps the account menu compact and keyboard accessible at %ipx",
    async (width) => {
      const { page, gateway } = await openPublication(
        width === 390
          ? {
              sessions: [
                createControlUiSessionRow("agent:main:main", "Main publication", 2),
                createControlUiSessionRow("agent:main:other", "Other publication", 1),
              ],
            }
          : {},
        width,
      );
      const reopenDetails = () =>
        width === 390 ? openChatPublication(page) : openChatDetails(page);
      await openChatPublication(page);
      const arrow =
        width === 390
          ? page.getByRole("button", { name: /^Publication account(?:$|:)/, includeHidden: true })
          : page.locator(".chat-environment__branch .chat-pr__actions-trigger");
      if ((await arrow.getAttribute("aria-expanded")) === "true") {
        await arrow.click();
      }
      await arrow.waitFor();
      const menu = page.locator(
        width === 390 ? ".github-publication-mobile__accounts-panel" : ".chat-pr-branch-menu",
      );
      const shared = menu.getByRole("menuitemradio", {
        name: width === 390 ? "@system-bot · System GitHub" : "@system-bot",
        exact: true,
      });
      const personal = menu.getByRole("menuitemradio", {
        name: width === 390 ? "@alice-tools · My GitHub" : "@alice-tools",
        exact: true,
      });
      await shared.waitFor({ state: "hidden" });
      expect(await shared.isVisible()).toBe(false);
      expect(await menu.locator("select").count()).toBe(0);
      const rowSelector =
        width === 390 ? ".github-publication-mobile" : ".chat-environment__branch";
      const row = page.locator(rowSelector);
      await waitForLayoutSettled(page, rowSelector);
      const closedBounds = await row.boundingBox();
      expect(closedBounds).not.toBeNull();
      await arrow.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => arrow.getAttribute("aria-expanded")).toBe("true");
      await shared.waitFor();
      await waitForLayoutSettled(page, rowSelector);
      expect(await shared.getAttribute("aria-checked")).toBe("true");
      expect(await personal.getAttribute("aria-checked")).toBe("false");
      expect((await row.boundingBox())?.height).toBeCloseTo(closedBounds!.height, 1);
      const accountBounds = await shared.boundingBox();
      expect(accountBounds).not.toBeNull();
      expect(accountBounds!.x).toBeGreaterThanOrEqual(0);
      expect(accountBounds!.x + accountBounds!.width).toBeLessThanOrEqual(width);
      await shared.focus();
      await page.keyboard.press("ArrowDown");
      expect(await personal.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      await personal.waitFor({ state: "hidden" });
      expect(await arrow.getAttribute("aria-expanded")).toBe("false");
      expect(await menu.locator('[value="personal"]').getAttribute("aria-checked")).toBe("true");
      expect(
        await publicationAction(page, width === 390 ? "Publish PR" : "Create PR").count(),
      ).toBe(1);
      await expect
        .poll(() => arrow.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await showPublicationBranch(gateway, "openclaw/updated-branch");
      await reopenDetails();
      await row
        .getByText("openclaw/updated-branch", { exact: true })
        .waitFor({ state: "attached" });
      await arrow.click();
      await personal.waitFor();
      expect(await personal.getAttribute("aria-checked")).toBe("true");
      expect(await shared.getAttribute("aria-checked")).toBe("false");
      await page.keyboard.press("Escape");
      await personal.waitFor({ state: "hidden" });
      expect(await arrow.getAttribute("aria-expanded")).toBe("false");
      await arrow.click();
      await personal.waitFor();
      await page.locator(".agent-chat__input textarea").click();
      await personal.waitFor({ state: "hidden" });
      expect(await arrow.getAttribute("aria-expanded")).toBe("false");
      if (width === 390) {
        await page.locator(".chat-mobile-host").waitFor({ state: "hidden" });
      } else {
        expect(await page.locator(".chat-details-toggle").getAttribute("aria-expanded")).toBe(
          "false",
        );
      }
      await reopenDetails();
      expect(await personal.isVisible()).toBe(false);
      if (width === 390) {
        await navigationDrawerToggle(page).click();
        await page
          .locator(
            '.sidebar-recent-session[data-session-key="agent:main:other"] a.sidebar-recent-session__link',
          )
          .click();
        await showPublicationBranch(gateway, "openclaw/other-publication", "agent:main:other");
        const otherReview = await openChatPublication(page);
        await expect
          .poll(() => otherReview.locator(".github-publication-mobile__branch").textContent())
          .toContain("openclaw/other-publication");
        expect(
          await otherReview.locator(".github-publication-mobile__branch").textContent(),
        ).not.toContain("openclaw/updated-branch");
      }
      expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
    },
  );

  it("gates personal publication for each session's workspace", async () => {
    const workspaces = [
      { name: "reclaimed", state: "reclaimed", running: false, conflict: false, ready: true },
      { name: "remote", state: "active", running: false, conflict: false, ready: false },
      { name: "running", state: "reclaimed", running: true, conflict: false, ready: false },
      { name: "conflicted", state: "reclaimed", running: false, conflict: true, ready: false },
    ];
    const now = Date.now();
    const rows = workspaces.map(({ name, state, running, conflict }, index) =>
      createControlUiSessionRow(
        index === 0 ? "agent:main:main" : `agent:main:publication-${name}`,
        `${name} publication workspace`,
        now,
        {
          hasActiveRun: running,
          status: running ? "running" : "done",
          placement: {
            state,
            generation: 1,
            createdAtMs: now,
            updatedAtMs: now,
            stateChangedAtMs: now,
            workspaceResultConflict: conflict
              ? {
                  paths: ["src/example.ts"],
                  stagedResultRef: "refs/openclaw/worker-results/test",
                  totalCount: 1,
                }
              : undefined,
          },
        },
      ),
    );
    const { page, gateway } = await openPublication({ sessions: rows });
    for (const [index, { name, conflict, ready }] of workspaces.entries()) {
      const sessionKey = rows[index]!.key;
      if (index !== 0) {
        await page
          .locator(
            `.sidebar-recent-session[data-session-key="${sessionKey}"] a.sidebar-recent-session__link`,
          )
          .click();
        await showPublicationBranch(gateway, undefined, sessionKey);
      }
      const publication = await openChatPublication(page);
      await selectPublicationAccount(publication, "personal");
      const publish = publication.getByRole("button", { name: "Create PR" });
      await publish.waitFor();
      await expect.poll(() => publish.isEnabled(), { message: `${name} workspace` }).toBe(ready);
      if (conflict) {
        const notice = page.locator(".chat-workspace-conflict-notice");
        await notice.getByRole("button", { name: "Dismiss workspace conflict notice" }).click();
        await notice.waitFor({ state: "hidden" });
        await openChatPublication(page);
        await page.getByRole("menuitemradio", { name: "@alice-tools", exact: true }).waitFor();
      }
      await page.keyboard.press("Escape");
      await page
        .locator(".chat-pane-cache__pane--active .chat-pr-branch-menu")
        .waitFor({ state: "hidden" });
    }
    expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
  });
}
