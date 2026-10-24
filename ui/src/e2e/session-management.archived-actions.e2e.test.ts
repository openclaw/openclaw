import type { Locator } from "playwright";
import { it, expect } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  closeChatDetails,
  openChatDetails,
  openChatPublication,
} from "./chat-details.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();
const options = createControlUiE2eContextOptions();
const baseTime = Date.parse("2026-07-01T16:00:00.000Z");

const branches = (current: string, other: string) => ({
  branches: [
    { active: true, headline: "Current branch", leafEntryId: current, messageCount: 2 },
    { active: false, headline: "Other branch", leafEntryId: other, messageCount: 1 },
  ],
});

async function expectVersionAuthority(activePane: Locator, mobile: boolean, disabled: boolean) {
  if (!mobile) {
    const trigger = activePane.locator(".chat-pane__branches-trigger");
    await ui.visible(trigger, 10_000);
    await expect.poll(() => trigger.isDisabled()).toBe(disabled);
    return;
  }
  const details = await openChatDetails(activePane);
  await details.locator('[data-details-destination="versions"]').click();
  const versions = details.locator('.chat-mobile-details-page[data-details-page="versions"]');
  const other = versions.getByRole("radio", { name: /^Other branch/u });
  await other.waitFor();
  await expect.poll(() => other.getAttribute("aria-disabled")).toBe(String(disabled));
  if (disabled) {
    await other.press("Enter");
    await expect.poll(() => other.getAttribute("aria-checked")).toBe("false");
  }
  await closeChatDetails(activePane);
}

suite.define(() => {
  it("waits for lifecycle actionability before activating a self-removing control once", () =>
    suite.withPage({ viewport: { width: 390, height: 320 } }, async ({ page }) => {
      for (const content of [
        '<main style="padding-top: 900px"><button disabled>Unarchive</button></main>',
        '<button disabled style="position: fixed; top: 300px; height: 100px">Unarchive</button>',
      ]) {
        await page.setContent(content);
        const unarchive = ui.button(page, "Unarchive");
        await unarchive.evaluate((button: HTMLButtonElement) => {
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
        await support.activateSelfRemovingControl(unarchive);
        expect(await unarchive.count()).toBe(0);
        expect(await page.locator("body").getAttribute("data-activations")).toBe("1");
      }
    }));

  it.each([
    { height: 900, label: "desktop", width: 1280 },
    { height: 844, label: "mobile", width: 390 },
  ] as const)("keeps archived transcript actions inert on $label", (viewport) =>
    suite.withPage({ ...options, viewport }, async ({ page }) => {
      const sessionKey = "agent:main:archive-actions";
      const messageText = "Archive action proof.";
      const session = sessionRow(sessionKey, "Archive actions", baseTime);
      const main = sessionRow("agent:main:main", "Main", baseTime + 1_000);
      const gateway = await ui.installSessionRows(page, [main, session], {
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
        historyMessages: (["user", "assistant"] as const).map((role, index) => ({
          role,
          content: index === 0 ? messageText : "Action proof response.",
          timestamp: baseTime + index,
          __openclaw: { id: `archive-action-${role}`, seq: index + 1 },
        })),
        mainSessionKey: "agent:main:main",
        methodResponses: {
          [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
          "sessions.branches.list": branches("archive-action-assistant", "archive-action-other"),
          "sessions.fork": {
            editorText: messageText,
            sessionKey: "agent:main:dashboard:archive-action-fork",
          },
        },
        sessionArchiveFiltering: true,
        sessionKey,
      });

      await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
      const transcript = activePane.locator(".chat-thread");
      const userBubble = activePane.locator(".chat-group.user .chat-bubble", {
        hasText: messageText,
      });
      await ui.visible(userBubble, 10_000);
      expect(await userBubble.getAttribute("data-entry-id")).toBe("archive-action-user");
      await expectVersionAuthority(activePane, viewport.label === "mobile", false);

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
      const publicationLabel = viewport.label === "mobile" ? "Publish PR" : "Create PR";
      const publication = await openChatPublication(activePane);
      await ui.button(publication, publicationLabel, false).waitFor();
      await closeChatDetails(activePane);

      await userBubble.click({ button: "right" });
      const menu = page.locator(".chat-reply-context-menu");
      await ui.visible(menu);
      const rewind = ui.menuItem(menu, "Rewind to here");
      expect(await rewind.count()).toBe(1);
      await rewind.click();
      const confirmation = page.locator(".chat-confirm-popover");
      await ui.visible(confirmation);
      const archived = { ...session, archived: true, archivedAt: baseTime + 2_000 };
      await gateway.setSessionsListResponse(support.sessionsListResponse([main, archived]));
      await gateway.emitGatewayEvent("sessions.changed", {
        ...archived,
        reason: "update",
        sessionKey,
      });

      const archivedNotice = activePane.locator(".agent-chat__disabled-banner");
      await ui.visible(archivedNotice, 10_000);
      await ui.expectCount(menu, 0);
      await ui.expectCount(confirmation, 0);
      await expect
        .poll(() => transcript.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await expectVersionAuthority(activePane, viewport.label === "mobile", true);
      const archivedPublication = await openChatPublication(activePane);
      await ui.expectCount(ui.button(archivedPublication, publicationLabel, false), 0);
      await closeChatDetails(activePane);

      await userBubble.evaluate((element) => {
        window.getSelection()?.selectAllChildren(element);
      });
      await userBubble.click({ button: "right" });
      await ui.visible(menu);
      expect({
        buttons: await menu.locator("button").count(),
        actions: await menu.getByRole("menuitem").allTextContents(),
      }).toEqual({ buttons: 3, actions: ["Copy", "Copy as markdown", "Fork from here"] });

      expect(
        await menu.evaluate((portal) => {
          const rect = portal.getBoundingClientRect();
          return [
            document.documentElement.scrollWidth > window.innerWidth,
            rect.left >= 0 &&
              rect.top >= 0 &&
              rect.right <= innerWidth &&
              rect.bottom <= innerHeight,
          ];
        }),
      ).toEqual([false, true]);

      await ui.menuItem(menu, "Fork from here").click();
      const fork = await gateway.waitForRequest("sessions.fork");
      expect(fork.params).toMatchObject({
        entryId: "archive-action-user",
        sessionKey,
      });
      await ui.expectNoRequests(
        gateway,
        "sessions.rewind",
        "sessions.branches.switch",
        "sessions.github.publish",
      );
    }),
  );
});
