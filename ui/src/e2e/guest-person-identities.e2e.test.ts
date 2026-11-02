import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { buildAuthenticatedPresenceUser } from "../../../src/gateway/authenticated-presence-user.js";
import { resolveCurrentUserProfileDisplay } from "../../../src/gateway/current-user-profile-display.js";
import { projectSessionActor } from "../../../src/gateway/session-identity-projection.js";
import { projectUserProfileDisplay } from "../../../src/state/user-profiles-internal.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { closeChatDetails, openChatDetailsPeople } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { seedStorage } from "./sidebar-assertions.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Guest people identities" });
const ids = ["00000001-0000-4000-8000-000000000001", "00000002-0000-4000-8000-000000000002"];
const sessionKey = "agent:main:guest-people";
const portrait =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#527866"/><circle cx="32" cy="24" r="12" fill="#f5d6b5"/><path d="M10 64c0-30 44-30 44 0" fill="#e3b367"/></svg>';

suite.define(() => {
  it("renders guest-visible names and photos without reading the private directory", () =>
    suite.withPage(
      { viewport: { width: 1280, height: 800 }, colorScheme: "dark" },
      async ({ page }) => {
        const profiles = new Map(
          ids.map((id, index) => {
            const display = projectUserProfileDisplay({
              id,
              display_name: index === 0 ? "Ada Lovelace" : null,
              avatar_mime: null,
              avatar_sha256: null,
              merged_into: null,
              updated_at: 1,
              has_avatar: 0,
              githubIdentity: {
                login: index === 0 ? "ada" : "octocat",
                profileUrl: "https://github.com/octocat",
                avatarUrl: "https://avatars.githubusercontent.com/u/42?v=4",
              },
            });
            const resolved = resolveCurrentUserProfileDisplay(id, () => display);
            return [id, resolved.kind === "resolved" ? resolved : undefined] as const;
          }),
        );
        const actors = ids.map((id) => projectSessionActor({ type: "human", id }, profiles)!);
        const sessions = actors.map((actor, index) => ({
          key: index === 0 ? sessionKey : "agent:main:github-person",
          kind: "direct",
          label: index === 0 ? "Shared research" : "Review work",
          createdActor: actor,
          owner: { actor },
          participants:
            index === 0
              ? [
                  {
                    identity: actors[1]!.identity!,
                    label: actors[1]!.label,
                    avatarUrl: actors[1]!.avatarUrl,
                  },
                ]
              : [],
          participantCount: index === 0 ? 1 : 0,
          updatedAt: 2 - index,
        }));
        const self = buildAuthenticatedPresenceUser({
          authenticatedUserId: "guest@example.test",
          authenticatedUserProfile: {
            profileId: "guest-profile",
            displayName: "Guest Person",
            avatarRevision: "1",
          },
        })!;
        const widths = new Map([
          ["guest-profile", 64],
          [ids[0]!, 65],
          [ids[1]!, 66],
        ]);
        await page.route("**/api/users/*/avatar*", (route) => {
          const id = new URL(route.request().url()).pathname.split("/")[3]!;
          const width = widths.get(id);
          if (!width) {
            throw new Error("Unexpected profile-avatar fixture: " + id);
          }
          return route.fulfill({
            contentType: "image/svg+xml",
            body: portrait.replace('width="64"', 'width="' + width + '"'),
          });
        });
        const railShortcuts = ["person:" + ids[1]];
        await seedStorage(page, {
          [controlUiBundledSettingsStorageKey(suite.server.baseUrl)]: JSON.stringify({
            railShortcuts,
            navigationByProfile: { "guest-profile": { railShortcuts } },
            themeMode: "dark",
          }),
        });
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.sessions.read", "operator.sessions.write"],
          featureMethods: ["chat.metadata", "chat.startup", "users.list", "users.prefs.get"],
          sessionKey,
          sessions,
          historyMessages: [{ role: "assistant", content: "Ready." }],
          presenceUsers: [{ ...self, self: true }],
          hasMultipleSessionSharingIdentities: true,
          methodResponses: {
            "users.prefs.get": {
              status: "ok",
              entries: { "ui.railShortcuts": railShortcuts, "ui.themeMode": "dark" },
            },
            "sessions.list": {
              count: sessions.length,
              owners: actors,
              defaults: { contextTokens: null, model: null, modelProvider: null },
              path: "",
              sessions,
              ts: 1,
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const account = page.locator(".sidebar-identity-card");
        const expectPhoto = async (image: import("playwright").Locator, width: number) => {
          await expectBrowser(image).toHaveCount(1);
          await expect
            .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
            .toBe(width);
        };
        await expectPhoto(account.locator("img"), 64);
        await account.click();
        const accountHeader = page.locator(".sidebar-identity-menu__header");
        await expectPhoto(accountHeader.locator("img"), 64);
        const accountFrame = await takeControlUiScreenshotFrame(
          page,
          accountHeader,
          [accountHeader],
          { animations: "disabled", elements: [accountHeader] },
        );
        await writeFile(
          path.join(suite.artifactDir, "account-menu.png"),
          accountFrame.elements[0]!.png,
        );
        await page.keyboard.press("Escape");
        const people = await openChatDetailsPeople(page);
        await expectPhoto(
          people.getByRole("link", { name: "Ada Lovelace Owner", exact: true }).locator("img"),
          65,
        );
        await expectPhoto(
          people.getByRole("link", { name: "octocat", exact: true }).locator("img"),
          66,
        );
        const peopleFrame = await takeControlUiScreenshotFrame(
          page,
          people,
          [people.locator(".chat-details-people")],
          { animations: "disabled", elements: [people] },
        );
        await writeFile(
          path.join(suite.artifactDir, "chat-people.png"),
          peopleFrame.elements[0]!.png,
        );
        await closeChatDetails(page);
        await page.locator("#sidebar-session-owner-title").click();
        const menu = page.getByRole("listbox");
        const ada = menu.locator('[data-value="owner:' + ids[0] + '"]');
        const github = menu.locator('[data-value="owner:' + ids[1] + '"]');
        await expectBrowser(ada).toBeVisible();
        await expectBrowser(github).toBeVisible();
        const frame = await takeControlUiScreenshotFrame(page, menu, [ada, github], {
          animations: "disabled",
          elements: [menu],
        });
        const stage = process.env.OPENCLAW_GUEST_IDENTITY_PROOF_STAGE ?? "after";
        await writeFile(path.join(suite.artifactDir, stage + ".png"), frame.png);
        await writeFile(
          path.join(suite.artifactDir, stage + "-owners.png"),
          frame.elements[0]!.png,
        );
        await expectBrowser(ada).toContainText("Ada Lovelace");
        await expectBrowser(github).toContainText("octocat");
        for (const row of [ada, github]) {
          await expectBrowser(row.locator("img")).toHaveCount(1);
          await expect
            .poll(() =>
              row.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth),
            )
            .toBeGreaterThan(0);
        }
        await github.click();
        await expectBrowser(page.locator("#sidebar-session-owner-title")).toHaveAccessibleName(
          "Owners: octocat",
        );
        await gateway.waitForRequest("sessions.list", { match: { ownerId: ids[1] } });
        await page.keyboard.press("ControlOrMeta+B");
        await page.locator(".shell--nav-collapsed").waitFor();
        const rail = page.locator(".sidebar-rail");
        const pin = rail.locator('[data-sidebar-entry="person:' + ids[1] + '"]');
        await expectPhoto(pin.locator("img"), 66);
        await expectPhoto(account.locator("img"), 64);
        const railFrame = await takeControlUiScreenshotFrame(page, rail, [pin, account], {
          animations: "disabled",
          elements: [rail],
        });
        await writeFile(
          path.join(suite.artifactDir, "compact-sidebar.png"),
          railFrame.elements[0]!.png,
        );
        expect(await gateway.getRequests("users.list")).toHaveLength(0);
      },
    ));
});
