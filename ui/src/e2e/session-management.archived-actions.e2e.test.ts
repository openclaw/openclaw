import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { closeChatDetails, openDetailsPullRequests } from "./chat-details.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  button as roleButton,
  menuItem,
  sessionPatch,
  visible,
} from "./session-management.compact.test-support.ts";
import {
  activateSelfRemovingControl,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const desktopOptions = {
  viewport: { width: 390, height: 320 },
} satisfies import("playwright").BrowserContextOptions;

suite.define(() => {
  it("waits for lifecycle actionability before activating a self-removing control once", async () => {
    return suite.withPage(desktopOptions, async ({ page }) => {
      for (const content of [
        '<main style="padding-top: 900px"><button disabled>Unarchive</button></main>',
        '<button disabled style="position: fixed; top: 300px; height: 100px">Unarchive</button>',
      ]) {
        await page.setContent(content);
        await page.evaluate(() => {
          const button = document.querySelector<HTMLButtonElement>("button");
          if (!button) {
            throw new Error("Lifecycle fixture control is missing");
          }
          document.body.dataset.activations = "0";
          button.addEventListener("click", () => {
            document.body.dataset.activations = String(
              Number(document.body.dataset.activations) + 1,
            );
            button.remove();
          });
          requestAnimationFrame(() => {
            button.disabled = false;
          });
        });
        const unarchive = roleButton(page, "Unarchive");
        await activateSelfRemovingControl(unarchive);
        expect(await unarchive.count()).toBe(0);
        expect(await page.locator("body").getAttribute("data-activations")).toBe("1");
      }
    });
  });

  for (const viewport of [
    { height: 900, label: "desktop", width: 1280 },
    { height: 844, label: "mobile", width: 390 },
  ] as const) {
    const pageOptions1 = { ...createControlUiE2eContextOptions(), viewport };
    it(`keeps archived transcript actions inert on ${viewport.label}`, async () => {
      return suite.withPage(pageOptions1, async ({ page, context }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: new URL(suite.server.baseUrl).origin,
        });

        const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
        const sessionKey = "agent:main:archive-actions";
        const messageText = "Archive action proof.";
        const session = sessionRow(sessionKey, "Archive actions", baseTime);
        const main = sessionRow("agent:main:main", "Main", baseTime + 1_000);
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "chat.metadata",
            "chat.startup",
            "sessions.branches.list",
            "sessions.branches.switch",
            "sessions.fork",
            "sessions.github.publish",
            "sessions.github.options",
            "sessions.patch",
            "sessions.rewind",
            SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
          ],
          historyMessages: [
            {
              role: "user",
              timestamp: baseTime,
              content: messageText,
              __openclaw: { id: "archive-action-user", seq: 1 },
            },
            {
              role: "assistant",
              timestamp: baseTime + 1,
              content: "Action proof response.",
              __openclaw: { id: "archive-action-assistant", seq: 2 },
            },
          ],
          mainSessionKey: "agent:main:main",
          methodResponses: {
            [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
            "sessions.branches.list": {
              branches: [
                {
                  active: true,
                  headline: "Current branch",
                  leafEntryId: "archive-action-assistant",
                  messageCount: 2,
                },
                {
                  active: false,
                  headline: "Other branch",
                  leafEntryId: "archive-action-other",
                  messageCount: 1,
                },
              ],
            },
            "sessions.fork": {
              editorText: messageText,
              sessionKey: "agent:main:dashboard:archive-action-fork",
            },
            "sessions.list": sessionsListResponse([main, session]),
          },
          sessionArchiveFiltering: true,
          sessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        const transcript = activePane.locator(".chat-thread");
        const userBubble = activePane.locator(".chat-group.user .chat-bubble", {
          hasText: messageText,
        });
        await visible(userBubble, 10_000);
        expect(await userBubble.getAttribute("data-entry-id")).toBe("archive-action-user");
        const branchTrigger = activePane.locator(".chat-pane__branches-trigger");
        await visible(branchTrigger, 10_000);
        expect(await branchTrigger.isDisabled()).toBe(false);

        await gateway.waitForRequest(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
        await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
          sessions: {
            [sessionKey]: {
              branch: {
                additions: 4,
                branch: "fix/archive-actions",
                deletions: 1,
                owner: "openclaw",
                repo: "openclaw",
              },
              pullRequests: [],
              rateLimited: false,
              status: "ok",
            },
          },
        });
        await openDetailsPullRequests(activePane);
        await roleButton(activePane, "Publish PR", false).waitFor();
        await closeChatDetails(activePane);

        await userBubble.click({ button: "right" });
        const initialMenu = page.locator(".chat-reply-context-menu");
        await visible(initialMenu);
        const rewind = menuItem(initialMenu, "Rewind to here");
        expect(await rewind.count()).toBe(1);
        await rewind.click();
        await visible(page.locator(".chat-confirm-popover"));

        const confirmation = page.locator(".chat-confirm-popover");
        const remember = confirmation.getByRole("checkbox");
        await remember.check();
        expect(await remember.isChecked()).toBe(true);
        await remember.uncheck();
        await roleButton(confirmation, "Cancel").click();
        await confirmation.waitFor({ state: "detached" });
        expect(await gateway.getRequests("sessions.rewind")).toHaveLength(0);
        expect(await initialMenu.isVisible()).toBe(true);
        expect(await rewind.evaluate((element) => element === document.activeElement)).toBe(true);
        await rewind.click();
        await visible(confirmation);

        const archived = {
          ...session,
          archived: true,
          archivedAt: baseTime + 2_000,
        };
        await gateway.setSessionsListResponse(sessionsListResponse([main, archived]));
        await gateway.emitGatewayEvent("sessions.changed", {
          ...archived,
          reason: "update",
          sessionKey,
        });

        const archivedNotice = activePane.locator(".agent-chat__disabled-banner");
        await visible(archivedNotice, 10_000);
        await expect.poll(() => page.locator(".chat-reply-context-menu").count()).toBe(0);
        await expect.poll(() => page.locator(".chat-confirm-popover").count()).toBe(0);
        await expect
          .poll(() => transcript.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await expect.poll(() => branchTrigger.isDisabled()).toBe(true);
        const archivedPullRequests = await openDetailsPullRequests(activePane);
        await expect
          .poll(() => roleButton(archivedPullRequests, "Publish PR", false).count())
          .toBe(0);
        await closeChatDetails(activePane);

        await userBubble.evaluate((element) => {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          selection?.removeAllRanges();
          selection?.addRange(range);
        });
        await userBubble.click({ button: "right" });
        const menu = page.locator(".chat-reply-context-menu");
        await visible(menu);
        const actions = menu.locator("button");
        expect(await actions.count()).toBe(3);
        for (const [index, name] of ["Copy", "Copy as markdown", "Fork from here"].entries()) {
          expect(
            await menuItem(menu, name).evaluate(
              (element, expected) => element === expected,
              await actions.nth(index).elementHandle(),
            ),
          ).toBe(true);
        }

        expect(
          await page.evaluate(() => {
            const portal = document.querySelector<HTMLElement>(".chat-reply-context-menu");
            const rect = portal?.getBoundingClientRect();
            return {
              documentOverflows: document.documentElement.scrollWidth > window.innerWidth,
              menuFits:
                Boolean(rect) &&
                rect!.left >= 0 &&
                rect!.top >= 0 &&
                rect!.right <= window.innerWidth &&
                rect!.bottom <= window.innerHeight,
            };
          }),
        ).toEqual({ documentOverflows: false, menuFits: true });

        await menuItem(menu, "Copy").click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(messageText);

        await page.evaluate(async () => {
          window.getSelection()?.removeAllRanges();
          await navigator.clipboard.writeText("Before archived message copy.");
        });
        await userBubble.click({ button: "right" });
        await menuItem(menu, "Copy as markdown").click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(messageText);

        await userBubble.click({ button: "right" });
        await menuItem(page.locator(".chat-reply-context-menu"), "Fork from here").click();
        const fork = await gateway.waitForRequest("sessions.fork");
        expect(requireRecord(fork.params)).toMatchObject({
          entryId: "archive-action-user",
          sessionKey,
        });
        expect(await gateway.getRequests("sessions.rewind")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.branches.switch")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.github.publish")).toHaveLength(0);
      });
    });
  }

  it("shows the archived notice when an archived session is cold-loaded outside the active list", async () => {
    return suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const archived = sessionRow(
        "agent:main:dashboard:cold-archive",
        "Archived planning",
        Date.parse("2026-07-01T16:00:00.000Z"),
        { archived: true },
      );
      const main = sessionRow("agent:main:main", "Main", archived.updatedAt + 1);
      const gateway = await installMockGateway(page, {
        mainSessionKey: "agent:main:main",
        sessions: [main, archived],
        methodResponses: {
          "sessions.branches.list": {
            branches: [
              { active: true, headline: "Current branch", leafEntryId: "current", messageCount: 2 },
              { active: false, headline: "Other branch", leafEntryId: "other", messageCount: 1 },
            ],
          },
          "sessions.list": sessionsListResponse([main]),
          "sessions.patch": {},
        },
        sessionArchiveFiltering: true,
        sessionKey: archived.key,
      });

      await page.goto(`${suite.server.baseUrl}chat?session=${encodeURIComponent(archived.key)}`);
      const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");

      const selectedRow = page.locator(
        `.sidebar-recent-session[data-session-key="${archived.key}"]`,
      );
      await visible(selectedRow, 10_000);
      await expect
        .poll(() => selectedRow.getAttribute("class"))
        .toContain("sidebar-recent-session--active");
      await visible(selectedRow.locator(".sidebar-session__archive-glyph"));
      await expect.poll(() => page.getByText("Archived planning", { exact: true }).count()).toBe(2);

      const archivedNotice = activePane.locator(".agent-chat__disabled-banner");
      await visible(archivedNotice, 10_000);
      await expect.poll(() => archivedNotice.textContent()).toContain("This session is archived.");
      await expect.poll(() => activePane.locator(".agent-chat__input").count()).toBe(0);
      await expect
        .poll(() => activePane.locator(".chat-pane__branches-trigger").isDisabled())
        .toBe(true);
      expect(await gateway.getRequests("sessions.branches.switch")).toHaveLength(0);

      await activateSelfRemovingControl(roleButton(archivedNotice, "Unarchive", false));
      await sessionPatch(gateway, archived.key, { archived: false });
      await gateway.emitGatewayEvent("sessions.changed", {
        ...archived,
        archived: false,
        archivedAt: undefined,
        reason: "update",
        sessionKey: archived.key,
      });

      await archivedNotice.waitFor({ state: "detached", timeout: 10_000 });
      await visible(activePane.locator(".agent-chat__input textarea"));
      await expect
        .poll(() =>
          activePane.evaluate(
            (element) => (element as HTMLElement & { sessionKey?: string }).sessionKey,
          ),
        )
        .toBe(archived.key);
    });
  });
});
