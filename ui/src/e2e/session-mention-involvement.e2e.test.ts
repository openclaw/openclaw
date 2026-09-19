import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { openSidebarSortMenu } from "./session-ownership-visuals.test-support.ts";

const suite = createSessionManagementE2eSuite(true);
const sessionKey = "agent:main:design-review";
const homeKey = "agent:main:my-work";
const person = (id: string, label: string) => ({
  type: "human" as const,
  id,
  label,
  identity: { type: "profile" as const, id },
});
const ada = person("profile-ada", "Ada");
const bob = person("profile-bob", "Bob");
const home = {
  key: homeKey,
  sessionId: "my-work",
  kind: "direct",
  label: "My work",
  owner: { actor: bob },
  createdActor: bob,
  updatedAt: Date.now() - 120_000,
  hiddenFromInvolvingMe: false,
};
const mentioned = {
  key: sessionKey,
  sessionId: "design-review",
  kind: "direct",
  label: "Design review",
  owner: { actor: ada },
  createdActor: ada,
  updatedAt: Date.now() - 60_000,
  hiddenFromInvolvingMe: false,
};
const list = (rows: unknown[]) => ({ ...sessionsListResponse(rows), owners: [ada, bob] });

suite.define(() => {
  it.each([false, true])(
    "offers personal visibility only with multiple identities (%s)",
    async (multiple) => {
      await suite.withPage(
        { viewport: { width: 1200, height: 820 }, colorScheme: "dark" },
        async ({ page }) => {
          await installMockGateway(page, {
            sessionKey: homeKey,
            hasMultipleSessionSharingIdentities: multiple,
            featureMethods: [...defaultControlUiFeatureMethods, "sessions.setInvolvement"],
            historyMessages: [
              { role: "assistant", content: [{ type: "text", text: "Ready for collaboration." }] },
            ],
            methodResponses: { "sessions.list": list([home, mentioned]) },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, homeKey));
          const target = page.locator('[data-session-key="' + sessionKey + '"]');
          await expectBrowser(target).toBeVisible();
          await target.hover();
          await target.getByRole("button", { name: "Open session menu" }).click();
          await expectBrowser(page.locator('openclaw-session-menu [value="rename"]')).toBeVisible();
          await captureUiProof(
            suite,
            page,
            multiple ? "06-multiple-identities-menu.png" : "05-single-identity-menu.png",
          );
          await expectBrowser(
            page.locator('openclaw-session-menu [value="toggle-involving-me"]'),
          ).toHaveCount(multiple ? 1 : 0);
        },
      );
    },
  );

  it("refreshes an involving-me list on mention and offers reversible personal hiding", async () => {
    await suite.withPage(
      { viewport: { width: 1200, height: 820 }, colorScheme: "dark" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: homeKey,
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: [{ self: true, id: bob.id, identity: bob.identity, name: bob.label }],
          featureMethods: [...defaultControlUiFeatureMethods, "sessions.setInvolvement"],
          historyMessages: [
            { role: "assistant", content: [{ type: "text", text: "Ready for collaboration." }] },
          ],
          methodResponses: {
            "sessions.list": list([home, mentioned]),
            "sessions.setInvolvement": { ok: true },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, homeKey));
        const target = page.locator('[data-session-key="' + sessionKey + '"]');
        await expectBrowser(target).toBeVisible();
        const chooseFilter = async (label: string) => {
          const menu = await openSidebarSortMenu(page);
          await menu.getByRole("menuitemradio", { name: label, exact: true }).click();
        };
        await gateway.setMethodResponse("sessions.list", list([home]));
        await chooseFilter("Involving me");
        await expectBrowser(target).toHaveCount(0);
        await captureUiProof(suite, page, "01-before-mention.png");

        // The Gateway owner test proves mention commit -> involvement. Here the real
        // client receives that owner's event while its filtered list is already open.
        await gateway.setMethodResponse("sessions.list", list([home, mentioned]));
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey,
          agentId: "main",
          reason: "involvement",
        });
        await expectBrowser(target).toBeVisible();
        expect((await gateway.getRequests("sessions.list")).at(-1)?.params).toMatchObject({
          involvingMe: true,
        });
        await captureUiProof(suite, page, "02-after-mention.png");
        await target.hover();
        await target.getByRole("button", { name: "Open session menu" }).click();
        const hide = page.getByRole("menuitem", { name: "Hide from Involving me", exact: true });
        await expectBrowser(hide).toBeVisible();
        await captureUiProof(suite, page, "03-personal-hide-menu.png");
        await gateway.setMethodResponse("sessions.list", list([home]));
        await hide.click();
        const request = await gateway.waitForRequest("sessions.setInvolvement");
        expect(request.params).toMatchObject({
          key: sessionKey,
          expectedSessionId: mentioned.sessionId,
          hidden: true,
        });
        await expectBrowser(target).toHaveCount(0);

        await gateway.setMethodResponse(
          "sessions.list",
          list([home, { ...mentioned, hiddenFromInvolvingMe: true }]),
        );
        await chooseFilter("All owners");
        await expectBrowser(target).toBeVisible();
        await target.hover();
        await target.getByRole("button", { name: "Open session menu" }).click();
        const show = page.getByRole("menuitem", { name: "Show in Involving me", exact: true });
        await expectBrowser(show).toBeVisible();
        await captureUiProof(suite, page, "04-restore-from-all-owners.png");
        await gateway.setMethodResponse("sessions.list", list([home, mentioned]));
        await show.click();
        await gateway.waitForRequest("sessions.setInvolvement", { after: 1 });
        expect((await gateway.getRequests("sessions.setInvolvement")).at(-1)?.params).toMatchObject(
          { hidden: false },
        );
        await chooseFilter("Involving me");
        await expectBrowser(target).toBeVisible();
        await page.reload();
        await expectBrowser(target).toBeVisible();
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      },
    );
  });
});
