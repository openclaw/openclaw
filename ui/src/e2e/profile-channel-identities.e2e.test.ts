import path from "node:path";
import { expect } from "playwright/test";
import { it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Profile channel identities",
  startServerBeforeBrowser: true,
});
const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Alex Morgan",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: ["alex@example.test"],
  githubIdentity: null,
  hasAvatar: false,
  role: "maintainer",
};
const identity = { channelId: "discord", accountId: "team-bot", senderId: "100000000000000001" };

suite.define(() => {
  it("lets an administrator link and unlink a verified sender for an existing person", async () => {
    const proof =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? createControlUiE2eArtifactDir("profile-channel-identities")
        : null;
    await suite.withPage({ viewport: { width: 1280, height: 1100 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.admin"],
        presenceUsers: [
          { self: true, id: profile.id, name: profile.displayName, email: profile.emails[0] },
        ],
        methodResponses: {
          "users.self": { profile },
          "users.list": { profiles: [profile] },
          "users.listChannelIdentities": { links: [] },
          "users.linkChannelIdentity": { profileId: profile.id, identity },
          "users.unlinkChannelIdentity": { removed: true },
        },
      });
      await page.goto(new URL("settings/profile", suite.server.baseUrl).href);
      await expect(page.locator(".identity-name-control input")).toHaveValue(profile.displayName);
      if (proof) {
        await page.screenshot({ path: path.join(proof, "profile.png"), animations: "disabled" });
      }
      const section = page.locator("#settings-profile-channel-identities");
      await section.getByRole("button", { name: "Manage channel identities" }).click();
      await section.getByLabel("Person", { exact: true }).selectOption(profile.id);
      await section.getByLabel("Channel", { exact: true }).fill(identity.channelId);
      await section.getByLabel("Channel account ID", { exact: true }).fill(identity.accountId);
      await section.getByLabel("Sender ID", { exact: true }).fill(identity.senderId);
      if (proof) {
        await section.screenshot({
          path: path.join(proof, "link-form.png"),
          animations: "disabled",
        });
      }
      await gateway.setMethodResponse("users.listChannelIdentities", {
        links: [{ profileId: profile.id, identity }],
      });
      await section.getByRole("button", { name: "Link identity", exact: true }).click();
      expect((await gateway.waitForRequest("users.linkChannelIdentity")).params).toEqual({
        profileId: profile.id,
        identity,
      });
      await expect(section.getByText(identity.senderId, { exact: true })).toBeVisible();
      if (proof) {
        await section.screenshot({ path: path.join(proof, "linked.png"), animations: "disabled" });
      }
      await gateway.setMethodResponse("users.listChannelIdentities", { links: [] });
      await section
        .getByRole("button", {
          name: `Unlink ${identity.channelId} · ${identity.accountId} · ${identity.senderId}`,
          exact: true,
        })
        .click();
      expect((await gateway.waitForRequest("users.unlinkChannelIdentity")).params).toEqual({
        profileId: profile.id,
        identity,
      });
      await expect(
        section.getByText("No channel identities linked.", { exact: true }),
      ).toBeVisible();
    });
  });
});
