import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol";
import type { Page } from "playwright";
import { it, expect } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import * as ui from "./session-management.compact.test-support.ts";
import * as support from "./session-management.test-support.ts";

const suite = support.createSessionManagementE2eSuite();
const marker = 1_800_000_000_001;
const badgeSelector = ".sidebar-session-indicator .session-glyph__badge--unread";
const unreadState = { icon: "📬", markedUnreadAt: marker, unread: true };

async function installUnreadRows(
  page: Page,
  primary: ReturnType<typeof sessionRow>,
  otherKey: string,
  options: Parameters<typeof ui.installSessionRows>[2] = {},
) {
  const other = sessionRow(otherKey, "Other thread", 10, { unread: false });
  const gateway = await ui.installSessionRows(page, [primary, other], {
    featureCapabilities: [GATEWAY_SERVER_CAPS.SESSION_UNREAD_ACK_CONTRACT],
    methodResponses: { "sessions.patch": {} },
    sessionKey: otherKey,
    ...options,
  });
  return { gateway, other };
}

const darkOptions = createControlUiE2eContextOptions();
darkOptions.colorScheme = "dark";

suite.define(() => {
  it.each([
    { visibility: "read-only", sharingRole: "viewer", restricted: true, mayRead: false },
    { visibility: "suggest", sharingRole: "viewer", restricted: true, mayRead: false },
    { visibility: "draft", sharingRole: "member", restricted: true, mayRead: false },
    { visibility: "shared", sharingRole: "viewer", restricted: false, mayRead: false },
    { visibility: "shared", sharingRole: "member", restricted: false, mayRead: true },
  ] as const)(
    "honors $visibility $sharingRole participation when acknowledging unread state",
    ({ visibility, sharingRole, restricted, mayRead }) =>
      suite.withPage(darkOptions, async ({ page }) => {
        const unreadKey = "agent:main:participation-read";
        const otherKey = "agent:main:participation-other";
        const unread = sessionRow(unreadKey, "Unread participation thread", 20, {
          ...unreadState,
          visibility,
          sharingRole,
        });
        const denial = "Synthetic participation restriction";
        const { gateway, other } = await installUnreadRows(page, unread, otherKey, {
          operatorScopes: ["operator.write"],
          hasMultipleSessionSharingIdentities: false,
          sessions: [unread, sessionRow(otherKey, "Other thread", 10, { unread: false })],
          methodResponses: {
            "sessions.patch": restricted
              ? { __mockError: { code: "INVALID_REQUEST", message: denial } }
              : {},
          },
        });
        const match = { key: unreadKey, unread: false };

        await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, otherKey));
        const row = page.locator(`[data-session-key="${unreadKey}"]`);
        const badge = row.locator(badgeSelector);
        const acknowledge = async () => {
          const request = await gateway.waitForRequest("sessions.patch", { match });
          expect(request.params).toMatchObject({ expectedMarkedUnreadAt: marker });
          await badge.waitFor({ state: "hidden" });
        };
        const publish = async (session: typeof unread) => {
          await gateway.setSessionsListResponse(support.sessionsListResponse([session, other]));
          await gateway.emitGatewayEvent("sessions.changed", {
            agentId: "main",
            reason: "run",
            sessionKey: unreadKey,
            session,
          });
        };
        await ui.visible(badge);
        expect(await gateway.getRequests("sessions.patch", match)).toHaveLength(0);
        await row.getByRole("link").click();
        await ui.expectSessionPath(page, unreadKey);
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        await ui.visible(pane);
        if (restricted) {
          await pane
            .getByText("Only the session owner and members can act in this session.")
            .waitFor();
        }
        await expect
          .poll(() => pane.locator(".agent-chat__composer-combobox textarea").isDisabled())
          .toBe(restricted);
        if (mayRead) {
          await acknowledge();
        }

        await expectRequestCountStable(gateway, "sessions.patch", mayRead ? 1 : 0, 500, match);
        if (mayRead) {
          return;
        }
        await ui.visible(badge);
        expect(await page.getByText(denial, { exact: true }).count()).toBe(0);

        const refreshedSession = {
          ...unread,
          label: "Refreshed participation thread",
          displayName: "Refreshed participation thread",
          updatedAt: 30,
        };
        await publish(refreshedSession);
        await row.getByText("Refreshed participation thread", { exact: true }).waitFor();
        await expectRequestCountStable(gateway, "sessions.patch", 0, 500, match);
        await ui.visible(badge);
        expect(await page.getByText(denial, { exact: true }).count()).toBe(0);

        if (visibility === "read-only") {
          await gateway.setMethodResponse("sessions.patch", {});
          const eligibleSession = { ...refreshedSession, sharingRole: "member", updatedAt: 40 };
          await publish(eligibleSession);
          await acknowledge();
          await expectRequestCountStable(gateway, "sessions.patch", 1, 500, match);
        }
      }),
  );

  it("clears an unread badge before the acknowledgement round trip", () =>
    suite.withPage(darkOptions, async ({ page }) => {
      const unreadKey = "agent:main:optimistic-read";
      const otherKey = "agent:main:optimistic-other";

      const { gateway } = await installUnreadRows(
        page,
        sessionRow(unreadKey, "Unread thread", 20, unreadState),
        otherKey,
      );
      let patchHeld = false;

      try {
        await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, otherKey));
        const row = page.locator(`[data-session-key="${unreadKey}"]`);
        const badge = row.locator(badgeSelector);
        await ui.visible(row, 10_000);
        await ui.visible(badge);

        // Swarm hydration also lists sessions, but never refreshes the sidebar roster.
        const rosterRequests = async () =>
          (await gateway.getRequests("sessions.list")).filter(
            (request) => !support.requireRecord(request.params).spawnedBy,
          );
        const listRequestsBefore = (await rosterRequests()).length;
        const patchRequestsBefore = await ui.requestCount(gateway, "sessions.patch");

        await gateway.deferNext("sessions.patch", { key: unreadKey, unread: false });
        await row.getByRole("link").evaluate((element) => {
          (element as HTMLElement).click();
        });
        await ui.sessionPatch(gateway, unreadKey, { unread: false });
        patchHeld = true;

        await badge.waitFor({ state: "hidden", timeout: 2_000 });
        await expect
          .poll(async () =>
            (await gateway.getRequests("sessions.list")).map(
              (request) => support.requireRecord(request.params).spawnedBy,
            ),
          )
          .toContain(unreadKey);
        expect((await ui.requestCount(gateway, "sessions.patch")) - patchRequestsBefore).toBe(1);
        expect((await rosterRequests()).length - listRequestsBefore).toBe(0);

        await gateway.resolveDeferred("sessions.patch");
        patchHeld = false;
        await ui.expectSessionPath(page, unreadKey);
        await badge.waitFor({ state: "hidden" });
      } finally {
        if (patchHeld) {
          await gateway.resolveDeferred("sessions.patch").catch(() => undefined);
        }
      }
    }));

  it("preserves manually unread state through active run updates until the session is reopened", () =>
    suite.withPage(darkOptions, async ({ page }) => {
      const activeKey = "agent:main:active";
      const otherKey = "agent:main:other";

      const { gateway } = await installUnreadRows(
        page,
        sessionRow(activeKey, "Active investigation", 20, { unread: false }),
        otherKey,
        { sessionKey: activeKey },
      );

      await page.goto(support.controlUiSessionUrl(suite.server.baseUrl, activeKey));
      const activeRow = page.locator(`[data-session-key="${activeKey}"]`);
      const otherRow = page.locator(`[data-session-key="${otherKey}"]`);
      await ui.visible(activeRow, 10_000);
      await ui.visible(otherRow);

      await activeRow.click({ button: "right" });
      await ui.menuItem(page, "Mark as unread", false).click();
      const markUnread = await ui.sessionPatch(gateway, activeKey, { unread: true });
      expect(support.requireRecord(markUnread.params)).not.toHaveProperty("expectedMarkedUnreadAt");

      await activeRow.locator(".sidebar-session-indicator .session-unread-dot").waitFor();
      await expectRequestCountStable(gateway, "sessions.patch", 1);

      for (const [updatedAt, status, indicator] of [
        [30, "running", ".session-glyph__ring"],
        [40, "done", ".session-unread-dot"],
      ] as const) {
        await gateway.emitGatewayEvent("sessions.changed", {
          reason: "run",
          sessionKey: activeKey,
          session: sessionRow(activeKey, "Active investigation", updatedAt, {
            hasActiveRun: status === "running",
            status,
            unread: true,
            markedUnreadAt: marker,
          }),
        });
        await activeRow.locator(`.sidebar-session-indicator ${indicator}`).waitFor();
        await expectRequestCountStable(gateway, "sessions.patch", 1);
      }

      await otherRow.getByRole("link").click();
      await ui.expectSessionPath(page, otherKey);
      await activeRow.getByRole("link").click();
      await ui.expectSessionPath(page, activeKey);

      const acknowledge = await ui.sessionPatch(gateway, activeKey, { unread: false });
      expect(support.requireRecord(acknowledge.params)).toMatchObject({
        expectedMarkedUnreadAt: marker,
        key: activeKey,
        unread: false,
      });
      expect(support.requireRecord(acknowledge.params)).not.toHaveProperty("readIntent");
    }));
});
