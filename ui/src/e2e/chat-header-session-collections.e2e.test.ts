import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createSessionManagementE2eSuite,
  controlUiSessionUrl,
  focusSessionMenuItem,
  installMockGateway,
  waitForSessionRosterHydration,
} from "./session-management.test-support.ts";
import { captureFrame } from "./sidebar-assertions.test-support.ts";

const suite = createSessionManagementE2eSuite();
const key = "agent:main:reliability";

suite.define(() => {
  it.each(["pointer", "Enter"] as const)(
    "opens the phone Add to section body through %s and adds without removing membership",
    async (entry) => {
      await suite.withPage(
        { reducedMotion: "reduce", viewport: { width: 400, height: 844 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            sessionKey: key,
            sessions: [createControlUiSessionRow(key, "Release planning", 1794520000000)],
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
          await waitForSessionRosterHydration(page);
          await evaluateControlUiContext(
            page,
            ({ navigation, theme }, sessionKey) => {
              theme.setMode("light");
              navigation.update({
                personalSessionGroups: [
                  { id: "member", label: "Already included", sessionKeys: [sessionKey] },
                  {
                    id: "release",
                    label: "Release readiness — documentation and operational follow-up",
                    sessionKeys: [],
                  },
                  ...Array.from({ length: 32 }, (_, index) => ({
                    id: "section-" + index,
                    label: "Project notes " + String(index + 1).padStart(2, "0"),
                    sessionKeys: [],
                  })),
                ],
              });
            },
            key,
          );
          const trigger = page.locator(".chat-header-session-menu__trigger:visible");
          await trigger.click();
          const add = page.getByRole("menuitem", { name: "Add to section", exact: true });
          await add.waitFor();
          if (entry === "Enter") {
            await focusSessionMenuItem(page, "Add to section");
            await page.keyboard.press("Enter");
          } else {
            await add.click();
          }
          const stage = process.env.OPENCLAW_ADD_SECTION_STAGE;
          if (stage && entry === "pointer") {
            const artifacts = createControlUiE2eArtifactDir("add-section-" + stage);
            await captureFrame(artifacts, "phone.png", page.locator(".shell"), []);
          }
          const body = page.locator(".session-actions-page:visible");
          await body.waitFor({ timeout: 3000 });
          expect(
            await body.getByRole("button", { name: "Already included", exact: true }).isDisabled(),
          ).toBe(true);
          expect(await body.getByRole("button").allTextContents()).toEqual([
            "Already included",
            "Release readiness — documentation and operational follow-up",
            ...Array.from(
              { length: 32 },
              (_, index) => "Project notes " + String(index + 1).padStart(2, "0"),
            ),
            "New section",
          ]);
          if (entry === "pointer") {
            const searchToggle = page
              .locator(".chat-mobile-host")
              .getByRole("button", { name: "Search", exact: true });
            await searchToggle.click();
            const search = body.getByRole("searchbox", { name: "Search", exact: true });
            await search.fill("not-a-section");
            await body.getByRole("status").getByText("No matches", { exact: true }).waitFor();
            expect(await body.getByRole("button").allTextContents()).toEqual(["New section"]);
            await search.fill("");
            expect(await body.getByRole("button").count()).toBe(35);
            await search.fill("RELEASE READINESS");
            expect(await body.getByRole("button").count()).toBe(2);
          }
          await body
            .getByRole("button", {
              name: "Release readiness — documentation and operational follow-up",
              exact: true,
            })
            .click();
          await expect
            .poll(() =>
              evaluateControlUiContext(page, ({ navigation }) =>
                navigation.snapshot.personalSessionGroups
                  ?.slice(0, 2)
                  .map((group) => group.sessionKeys),
              ),
            )
            .toEqual([[key], [key]]);
          await body.waitFor({ state: "hidden" });
          await trigger.click();
          await page.getByRole("menuitem", { name: "Add to section", exact: true }).click();
          await body.waitFor();
          expect(await body.getByRole("searchbox").count()).toBe(0);
          expect(await body.getByRole("button").count()).toBe(35);
          await page.keyboard.press("Escape");
          await body.waitFor({ state: "hidden" });
          await expect
            .poll(() => trigger.evaluate((element) => element === document.activeElement))
            .toBe(true);
          if (entry === "pointer") {
            await evaluateControlUiContext(page, ({ navigation }) =>
              navigation.update({ personalSessionGroups: [] }),
            );
            await trigger.click();
            await page.getByRole("menuitem", { name: "Add to section", exact: true }).click();
            await body.waitFor();
            expect(await body.getByRole("button").allTextContents()).toEqual(["New section"]);
            expect(
              await page
                .locator(".chat-mobile-host")
                .getByRole("button", { name: "Search", exact: true })
                .count(),
            ).toBe(0);
            await page
              .locator(".chat-mobile-host")
              .getByRole("button", { name: "Close", exact: true })
              .click();
            await body.waitFor({ state: "hidden" });
            await trigger.click();
            await page.getByRole("menuitem", { name: "Add to section", exact: true }).click();
            await body.getByRole("button", { name: "New section", exact: true }).click();
            const dialog = page.getByRole("dialog", { name: "New section", exact: true });
            await dialog.waitFor();
            await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
            await dialog.waitFor({ state: "hidden" });
          }
          expect(await gateway.getRequests("sessions.patch")).toEqual([]);
          expect(await gateway.getRequests("sessions.groups.put")).toEqual([]);
        },
      );
    },
  );
});
