import type { Locator, Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  waitForSessionRosterHydration,
} from "./session-management.test-support.ts";
import { sessionPerson } from "./session-ownership-fixtures.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";
import { chooseSidebarOwner, closeSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createSessionManagementE2eSuite();
const sessionKey = "agent:main:design-review";
const homeKey = "agent:main:my-work";
const ada = sessionPerson("profile-ada", "Ada");
const bob = sessionPerson("profile-bob", "Bob");
function session(key: string, label: string, actor: typeof ada, age: number) {
  return {
    key,
    sessionId: key.slice("agent:main:".length),
    kind: "direct",
    label,
    owner: { actor },
    createdActor: actor,
    updatedAt: Date.now() - age,
    hiddenFromInvolvingMe: false,
  };
}
const home = session(homeKey, "My work", bob, 120_000);
const mentioned = {
  ...session(sessionKey, "Design review", ada, 60_000),
  sharingRole: "viewer",
};
const list = (rows: unknown[]) => ({ ...sessionsListResponse(rows), owners: [ada, bob] });

function withSession(
  multiple: boolean,
  run: (
    page: Page,
    gateway: Awaited<ReturnType<typeof installMockGateway>>,
    target: Locator,
  ) => Promise<void>,
  collaboration = false,
) {
  return suite.withPage(
    { viewport: { width: 1200, height: 820 }, colorScheme: "dark" },
    async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: homeKey,
        hasMultipleSessionSharingIdentities: multiple,
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.setInvolvement"],
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text: "Ready for collaboration." }] },
        ],
        ...(collaboration
          ? {
              operatorScopes: ["operator.sessions.read"],
              presenceUsers: [{ self: true, id: bob.id, identity: bob.identity, name: bob.label }],
            }
          : {}),
        methodResponses: {
          "sessions.list": list([home, mentioned]),
          ...(collaboration ? { "sessions.setInvolvement": { ok: true } } : {}),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, homeKey));
      await waitForSessionRosterHydration(page);
      if (collaboration) {
        await selectAllSidebarSessions(page);
      }
      const target = page.locator(`[data-session-key="${sessionKey}"]`);
      await expectBrowser(target).toBeVisible();
      await run(page, gateway, target);
    },
  );
}

suite.define(() => {
  it("omits personal visibility with a single identity", () =>
    withSession(false, async (page, _gateway, target) => {
      await target.hover();
      await target.click({ button: "right" });
      await expectBrowser(page.locator('openclaw-session-menu [value="rename"]')).toBeVisible();
      await expectBrowser(
        page.locator('openclaw-session-menu [value="toggle-involving-me"]'),
      ).toHaveCount(0);
    }));

  it("lets a session reader reversibly hide a foreign mentioned session from Involving me", () =>
    withSession(
      true,
      async (page, gateway, target) => {
        const chooseFilter = async (value: "all" | "involving-me") => {
          await chooseSidebarOwner(page, value);
          await closeSidebarMenu(page);
        };
        await gateway.setMethodResponse("sessions.list", list([home]));
        await chooseFilter("involving-me");
        await expectBrowser(target).toHaveCount(0);

        // The Gateway owner test proves mention commit -> involvement. Here the real
        // client receives that owner's event while its filtered list is already open.
        const involvingMeQuery = { involvingMe: true };
        const beforeMention = (await gateway.getRequests("sessions.list", involvingMeQuery)).length;
        await gateway.setMethodResponse("sessions.list", list([home, mentioned]));
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey,
          agentId: "main",
          reason: "involvement",
        });
        await gateway.waitForRequest("sessions.list", {
          match: involvingMeQuery,
          after: beforeMention,
        });
        await expectBrowser(target).toBeVisible();

        const hiddenMentioned = { ...mentioned, hiddenFromInvolvingMe: true };
        const setHidden = async (hidden: boolean) => {
          await target.hover();
          await target.click({ button: "right" });
          if (!hidden) {
            await page.getByRole("menuitem", { name: "Advanced", exact: true }).click();
          }
          const action = page.getByRole("menuitem", {
            name: hidden ? "Hide from Involving me" : "Show in Involving me",
            exact: true,
          });
          await expectBrowser(action).toBeVisible();

          await gateway.deferNext("sessions.setInvolvement");
          await action.click();
          const request = await gateway.waitForRequest(
            "sessions.setInvolvement",
            hidden ? undefined : { after: 1 },
          );
          expect(request.params).toMatchObject({
            key: sessionKey,
            expectedSessionId: mentioned.sessionId,
            hidden,
          });
          await gateway.setSessionsListResponse(list([home, hidden ? hiddenMentioned : mentioned]));
          if (hidden) {
            await gateway.setMethodResponse("sessions.list", list([home]));
          }
          await gateway.resolveDeferred("sessions.setInvolvement", { ok: true });
        };
        await setHidden(true);
        await expectBrowser(target).toHaveCount(0);
        await gateway.setMethodResponse("sessions.list", list([home, hiddenMentioned]));
        await chooseFilter("all");
        await expectBrowser(target).toBeVisible();
        await setHidden(false);
        await chooseFilter("involving-me");
        await expectBrowser(target).toBeVisible();
        expect(await gateway.getRequests("sessions.setInvolvement")).toHaveLength(2);
        await page.reload();
        await waitForSessionRosterHydration(page);
        await expectBrowser(target).toBeVisible();
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      },
      true,
    ));
});
