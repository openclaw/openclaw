import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { sessionMenuSubmenu } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session owner search readiness audit" });
suite.define(() => {
  it.each([1280, 390])(
    "waits for the people directory before claiming no search matches at width %i",
    async (width) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width, height: 900 } },
        async ({ page }) => {
          const key = "agent:main:dashboard:owner-readiness";
          const actor = { type: "human", id: "profile-bob", label: "Bob" };
          const gateway = await installMockGateway(page, {
            sessionKey: key,
            sessions: [
              {
                key,
                kind: "direct",
                label: "Research notes",
                createdActor: actor,
                owner: { actor },
                updatedAt: 1,
              },
            ],
            presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
            operatorScopes: ["operator.read", "operator.write"],
            featureMethods: ["chat.startup", "sessions.assignOwner", "users.list"],
            deferredMethods: ["users.list"],
            methodResponses: {
              "users.list": {
                profiles: ["Ada", "Bob", "Carol"].map((displayName) => ({
                  id: "profile-" + displayName.toLowerCase(),
                  displayName,
                  avatarMime: null,
                  mergedInto: null,
                  createdAt: 1,
                  updatedAt: 1,
                  emails: [],
                  githubIdentity: null,
                  hasAvatar: false,
                })),
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
          await page
            .getByRole("button", { name: "Actions for Research notes", exact: true })
            .click();
          const assignTo = page.getByRole("menuitem", { name: /^Assign to…?$/u });
          if (width < 560) {
            await assignTo.click();
          } else {
            await assignTo.hover();
          }
          const panel =
            width < 560
              ? page.locator(".session-actions-page:visible")
              : sessionMenuSubmenu(assignTo);
          const search = panel.getByRole("searchbox", { name: "Search people and agents…" });
          await expectBrowser(search).toBeVisible();
          await gateway.waitForRequest("users.list");
          await search.fill("Carol");
          await expectBrowser(panel).toContainText("Loading");
          const noMatch = panel.getByText("No people or agents match your search.", {
            exact: true,
          });
          const prematurePending = await noMatch.count();
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const frame = await takeControlUiScreenshotFrame(page, panel, [search], {
              animations: "disabled",
            });
            await writeFile(
              path.join(suite.artifactDir, "owner-pending-" + width + ".png"),
              frame.png,
            );
          }
          await gateway.rejectDeferred("users.list", {
            code: "UNAVAILABLE",
            message: "The people directory could not be loaded.",
          });
          await expectBrowser(panel.getByRole("alert")).toContainText(
            "The people directory could not be loaded.",
          );
          const prematureFailure = await noMatch.count();
          const retry = panel.getByRole(width < 560 ? "button" : "menuitem", {
            name: "Retry",
            exact: true,
          });
          await retry.click();
          if (width < 560) {
            await expectBrowser(panel).toBeHidden();
            await page
              .getByRole("button", { name: "Actions for Research notes", exact: true })
              .click();
            await assignTo.click();
          }
          // An explicit directory reload resets the menu's search generation.
          await expectBrowser(search).toHaveValue("");
          await search.fill("Nobody here");
          await expectBrowser(noMatch).toBeVisible();
          await search.fill("Carol");
          const carol = panel.getByRole(width < 560 ? "button" : "menuitemradio", {
            name: "Carol",
            exact: true,
          });
          await expectBrowser(carol).toBeVisible();
          await expectBrowser(noMatch).toHaveCount(0);
          expect(await gateway.getRequests("sessions.assignOwner")).toHaveLength(0);
          expect
            .soft(
              prematurePending,
              "An unfinished directory cannot establish that no person matches",
            )
            .toBe(0);
          expect
            .soft(prematureFailure, "A failed directory cannot establish that no person matches")
            .toBe(0);
        },
      );
    },
  );
});
