import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const key = "agent:main:dashboard:619dfdde-5f1b-4f7f-be9c-68ab72f812f8";
const title = "Sharing readiness review";
const owner = { type: "human", id: "owner", label: "Owner" };

suite.define(() => {
  for (const mobile of [false, true]) {
    it(
      "does not call a failed first membership read empty on " + (mobile ? "phone" : "desktop"),
      async () => {
        await suite.withPage(
          {
            locale: "en-US",
            serviceWorkers: "block",
            hasTouch: mobile,
            viewport: { width: mobile ? 390 : 1280, height: 900 },
          },
          async ({ page }) => {
            const gateway = await installMockGateway(page, {
              sessionKey: key,
              featureMethods: [
                "chat.metadata",
                "chat.startup",
                "session.visibility.set",
                "session.members.listEvidence",
                "session.publicShare.set",
              ],
              operatorScopes: ["operator.read", "operator.write"],
              heldMethods: ["session.members.listEvidence"],
              methodResponses: {
                "sessions.list": sessionsListResponse([
                  sessionRow(key, title, Date.now(), {
                    sharingRole: "owner",
                    visibility: "read-only",
                  }),
                ]),
                "session.members.listEvidence": {
                  sessionKey: key,
                  owner,
                  members: [],
                  identities: [owner],
                  permissions: [],
                  role: "owner",
                  allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
                },
              },
            });
            await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
            const surface = mobile
              ? page
                  .locator(".chat-mobile-host")
                  .filter({ visible: true })
                  .locator('[data-mobile-page="sharing"]')
              : page.locator(".chat-pane__sharing-panel");
            const open = async () => {
              if (mobile) {
                await page
                  .getByRole("button", { name: "Actions for " + title, exact: true })
                  .click();
                await page
                  .getByRole("menu", { name: "Actions for " + title, exact: true })
                  .getByRole("menuitem", { name: "Sharing options", exact: true })
                  .click();
              } else {
                await page.locator(".chat-pane__sharing-trigger").filter({ visible: true }).click();
              }
              await surface.waitFor();
            };
            const close = async () => {
              if (mobile) {
                await page
                  .locator(".chat-mobile-host")
                  .filter({ visible: true })
                  .locator(".chat-mobile-host__header")
                  .getByRole("button", { name: "Close", exact: true })
                  .click();
              } else {
                await page.keyboard.press("Escape");
              }
              await surface.waitFor({ state: "hidden" });
            };
            await open();
            await gateway.waitForRequest("session.members.listEvidence");
            await surface.locator(".panel-loading-content").waitFor();
            const empty = surface.getByText("No paired people yet.", { exact: true });
            expect(await empty.count()).toBe(0);
            await gateway.rejectDeferred("session.members.listEvidence", {
              code: "UNAVAILABLE",
              message: "Could not read the sharing roster",
            });
            const error = surface
              .getByRole("alert")
              .filter({ hasText: "Could not read the sharing roster" });
            await error.waitFor();
            const falseEmpty = await empty.count();
            if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
              const frame = await takeControlUiScreenshotFrame(page, surface, [error], {
                animations: "disabled",
              });
              await writeFile(path.join(suite.artifactDir, "sharing-first-read.png"), frame.png);
            }
            const reads = (await gateway.getRequests("session.members.listEvidence")).length;
            await close();
            await open();
            await gateway.waitForRequest("session.members.listEvidence", { after: reads });
            await surface.getByText("Owner", { exact: true }).first().waitFor();
            expect(await error.count()).toBe(0);
            expect(await empty.count()).toBe(0);
            await close();
            const refreshReads = await gateway.deferNext("session.members.listEvidence");
            await open();
            await gateway.waitForRequest("session.members.listEvidence", { after: refreshReads });
            await gateway.rejectDeferred("session.members.listEvidence", {
              code: "UNAVAILABLE",
              message: "Could not read the sharing roster",
            });
            await error.waitFor();
            await surface.getByText("Owner", { exact: true }).first().waitFor();
            expect(await empty.count()).toBe(0);
            expect(await gateway.getRequests("session.visibility.set")).toHaveLength(0);
            expect(await gateway.getRequests("session.publicShare.set")).toHaveLength(0);
            expect(
              falseEmpty,
              "Failed membership discovery is not proof that no people are paired",
            ).toBe(0);
          },
        );
      },
    );
  }
});
