import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import { menuItem, sessionPatch, visible } from "./session-management.compact.test-support.ts";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

const darkOptions = {
  colorScheme: "dark",
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1280 },
} satisfies import("playwright").BrowserContextOptions;

suite.define(() => {
  it.each([
    { visibility: "read-only", sharingRole: "viewer", restricted: true, acknowledgesRead: false },
    { visibility: "suggest", sharingRole: "viewer", restricted: true, acknowledgesRead: false },
    { visibility: "draft", sharingRole: "member", restricted: true, acknowledgesRead: false },
    { visibility: "shared", sharingRole: "viewer", restricted: false, acknowledgesRead: false },
    { visibility: "shared", sharingRole: "member", restricted: false, acknowledgesRead: true },
  ] as const)(
    "honors $visibility $sharingRole participation when acknowledging unread state",
    async ({ visibility, sharingRole, restricted, acknowledgesRead }) => {
      const unreadKey = "agent:main:participation-read";
      const otherKey = "agent:main:participation-other";
      const marker = 1_800_000_000_001;
      const unreadSession = sessionRow(unreadKey, "Unread participation thread", 20, {
        icon: "📬",
        markedUnreadAt: marker,
        unread: true,
        visibility,
        sharingRole,
      });
      const otherSession = sessionRow(otherKey, "Other thread", 10, { unread: false });
      const denial = "Synthetic participation restriction";
      return suite.withPage(darkOptions, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.write"],
          featureCapabilities: [GATEWAY_SERVER_CAPS.SESSION_UNREAD_ACK_CONTRACT],
          hasMultipleSessionSharingIdentities: false,
          sessions: [unreadSession, otherSession],
          methodResponses: {
            "sessions.list": sessionsListResponse([unreadSession, otherSession]),
            "sessions.patch": restricted
              ? { __mockError: { code: "INVALID_REQUEST", message: denial } }
              : {},
          },
          sessionKey: otherKey,
        });
        const match = { key: unreadKey, unread: false };

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, otherKey));
        const unreadRow = page.locator(`[data-session-key="${unreadKey}"]`);
        const unreadBadge = unreadRow.locator(
          ".sidebar-session-indicator .session-glyph__badge--unread",
        );
        await visible(unreadBadge);
        expect(await gateway.getRequests("sessions.patch", match)).toHaveLength(0);
        await unreadRow.getByRole("link").click();
        await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(unreadKey));
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        await visible(pane);
        if (restricted) {
          await pane
            .getByText("Only the session owner and members can act in this session.")
            .waitFor();
        }
        await expect
          .poll(() => pane.locator(".agent-chat__composer-combobox textarea").isDisabled())
          .toBe(restricted);
        if (acknowledgesRead) {
          const acknowledgement = await gateway.waitForRequest("sessions.patch", { match });
          expect(acknowledgement.params).toMatchObject({ expectedMarkedUnreadAt: marker });
          await unreadBadge.waitFor({ state: "hidden" });
        }

        await expectRequestCountStable(
          gateway,
          "sessions.patch",
          acknowledgesRead ? 1 : 0,
          500,
          match,
        );
        if (acknowledgesRead) {
          return;
        }
        await visible(unreadBadge);
        expect(await page.getByText(denial, { exact: true }).count()).toBe(0);

        const refreshedSession = {
          ...unreadSession,
          label: "Refreshed participation thread",
          displayName: "Refreshed participation thread",
          updatedAt: 30,
        };
        await gateway.setSessionsListResponse(
          sessionsListResponse([refreshedSession, otherSession]),
        );
        await gateway.emitGatewayEvent("sessions.changed", {
          agentId: "main",
          reason: "run",
          sessionKey: unreadKey,
          session: refreshedSession,
        });
        await unreadRow.getByText("Refreshed participation thread", { exact: true }).waitFor();
        await expectRequestCountStable(gateway, "sessions.patch", 0, 500, match);
        await visible(unreadBadge);
        expect(await page.getByText(denial, { exact: true }).count()).toBe(0);

        if (visibility === "read-only") {
          await gateway.setMethodResponse("sessions.patch", {});
          const eligibleSession = { ...refreshedSession, sharingRole: "member", updatedAt: 40 };
          await gateway.setSessionsListResponse(
            sessionsListResponse([eligibleSession, otherSession]),
          );
          await gateway.emitGatewayEvent("sessions.changed", {
            agentId: "main",
            reason: "run",
            sessionKey: unreadKey,
            session: eligibleSession,
          });
          const acknowledgement = await gateway.waitForRequest("sessions.patch", { match });
          expect(acknowledgement.params).toMatchObject({ expectedMarkedUnreadAt: marker });
          await unreadBadge.waitFor({ state: "hidden" });
          await expectRequestCountStable(gateway, "sessions.patch", 1, 500, match);
        }
      });
    },
  );

  it("clears an unread badge before the acknowledgement round trip", async () => {
    const unreadKey = "agent:main:optimistic-read";
    const otherKey = "agent:main:optimistic-other";
    return suite.withPage(darkOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureCapabilities: [GATEWAY_SERVER_CAPS.SESSION_UNREAD_ACK_CONTRACT],
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow(unreadKey, "Unread thread", 20, {
              icon: "📬",
              markedUnreadAt: 1_800_000_000_001,
              unread: true,
            }),
            sessionRow(otherKey, "Other thread", 10, { unread: false }),
          ]),
          "sessions.patch": {},
        },
        sessionKey: otherKey,
      });
      let patchHeld = false;

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, otherKey));
        const unreadRow = page.locator(`[data-session-key="${unreadKey}"]`);
        const unreadBadge = unreadRow.locator(
          ".sidebar-session-indicator .session-glyph__badge--unread",
        );
        await visible(unreadRow, 10_000);
        await visible(unreadBadge);

        // Swarm hydration also lists sessions, but never refreshes the sidebar roster.
        const rosterRequests = async () =>
          (await gateway.getRequests("sessions.list")).filter(
            (request) => !requireRecord(request.params).spawnedBy,
          );
        const listRequestsBefore = (await rosterRequests()).length;
        const patchRequestsBefore = (await gateway.getRequests("sessions.patch")).length;

        await gateway.deferNext("sessions.patch", { key: unreadKey, unread: false });
        await unreadRow.getByRole("link").evaluate((element) => {
          (element as HTMLElement).click();
        });
        await sessionPatch(gateway, unreadKey, { unread: false });
        patchHeld = true;

        await unreadBadge.waitFor({ state: "hidden", timeout: 2_000 });
        await expect
          .poll(async () =>
            (await gateway.getRequests("sessions.list")).map(
              (request) => requireRecord(request.params).spawnedBy,
            ),
          )
          .toContain(unreadKey);
        expect((await gateway.getRequests("sessions.patch")).length - patchRequestsBefore).toBe(1);
        expect((await rosterRequests()).length - listRequestsBefore).toBe(0);

        await gateway.resolveDeferred("sessions.patch");
        patchHeld = false;
        await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(unreadKey));
        await unreadBadge.waitFor({ state: "hidden" });
      } finally {
        if (patchHeld) {
          await gateway.resolveDeferred("sessions.patch").catch(() => undefined);
        }
      }
    });
  });

  it("preserves manually unread state through active run updates until the session is reopened", async () => {
    const activeKey = "agent:main:active";
    const otherKey = "agent:main:other";
    return suite.withPage(darkOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureCapabilities: [GATEWAY_SERVER_CAPS.SESSION_UNREAD_ACK_CONTRACT],
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow(activeKey, "Active investigation", 20, { unread: false }),
            sessionRow(otherKey, "Other thread", 10, { unread: false }),
          ]),
          "sessions.patch": {},
        },
        sessionKey: activeKey,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, activeKey));
      const activeRow = page.locator(`[data-session-key="${activeKey}"]`);
      const otherRow = page.locator(`[data-session-key="${otherKey}"]`);
      await visible(activeRow, 10_000);
      await visible(otherRow);

      await activeRow.click({ button: "right" });
      await menuItem(page, "Mark as unread", false).click();
      const markUnread = await sessionPatch(gateway, activeKey, { unread: true });
      expect(requireRecord(markUnread.params)).not.toHaveProperty("expectedMarkedUnreadAt");

      await activeRow.locator(".sidebar-session-indicator .session-unread-dot").waitFor();
      await expectRequestCountStable(gateway, "sessions.patch", 1);

      const marker = 1_800_000_000_001;
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
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(otherKey));
      await activeRow.getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(activeKey));

      const acknowledge = await sessionPatch(gateway, activeKey, { unread: false });
      expect(requireRecord(acknowledge.params)).toMatchObject({
        expectedMarkedUnreadAt: marker,
        key: activeKey,
        unread: false,
      });
      expect(requireRecord(acknowledge.params)).not.toHaveProperty("readIntent");
    });
  });
});
