import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installMockGateway, sessionsListResponse } from "./session-management.test-support.ts";
import { chooseSidebarOwner } from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar involvement" });

suite.define(() => {
  it("keeps cached Home and nested children inside the Gateway's involvement membership", async () => {
    await suite.withPage(
      { colorScheme: "light", locale: "en-US", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const now = Date.now();
        const mainKey = "agent:main:main";
        const sharedKey = "agent:main:dashboard:shared";
        const unrelatedKey = "agent:main:dashboard:unrelated";
        const nestedKey = "agent:main:dashboard:nested";
        const unrelatedNestedKey = "agent:main:dashboard:unrelated-nested";
        const viewer = { type: "human" as const, id: "profile-ada", label: "Ada" };
        const bot = { type: "agent" as const, id: "main", label: "Harbor" };
        const home = sessionRow(mainKey, "Home", now, {
          owner: { actor: viewer },
          childSessions: [sharedKey, unrelatedKey],
        });
        const own = sessionRow("agent:main:dashboard:mine", "My dependency update", now, {
          owner: { actor: viewer },
        });
        // Membership is server-owned: even an empty participant preview cannot
        // exclude a conversation returned by the personal query.
        const shared = sessionRow(sharedKey, "Shared PR review", now + 1, {
          owner: { actor: bot },
          participants: [],
          spawnedBy: mainKey,
          childSessions: [nestedKey, unrelatedNestedKey],
        });
        const unrelated = sessionRow(unrelatedKey, "Unrelated PR landing", now + 2, {
          owner: { actor: bot },
          spawnedBy: mainKey,
        });
        const nested = sessionRow(nestedKey, "My follow-up review", now + 3, {
          owner: { actor: bot },
          spawnedBy: sharedKey,
        });
        const unrelatedNested = sessionRow(
          unrelatedNestedKey,
          "Another person's follow-up",
          now + 4,
          {
            owner: { actor: bot },
            spawnedBy: sharedKey,
          },
        );
        const all = [home, own, shared, unrelated, nested, unrelatedNested];
        const response = (rows: typeof all) => ({
          ...sessionsListResponse(rows),
          owners: [viewer, bot],
        });
        await seedChatSettings(page, suite.server.baseUrl, {
          sidebarAgentsMode: "chip",
          themeMode: "light",
          navWidth: 360,
        });
        const gateway = await installMockGateway(page, {
          sessionKey: mainKey,
          sessions: all,
          presenceUsers: [{ id: viewer.id, name: viewer.label, self: true }],
          methodResponses: {
            "sessions.list": {
              cases: [
                { match: { involvingMe: true }, response: response([home, own, shared, nested]) },
                { response: response(all) },
              ],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        await chooseSidebarOwner(page, "all");
        const sidebar = page.locator("openclaw-app-sidebar");
        const row = (key: string) => sidebar.locator(`[data-session-key="` + key + `"]`);
        await row(unrelatedKey).waitFor();
        const toggle = sidebar.locator(`[data-child-session-toggle="` + sharedKey + `"]`);
        await toggle.waitFor();
        if ((await toggle.getAttribute("aria-expanded")) !== "true") {
          await toggle.click();
        }
        await row(unrelatedNestedKey).waitFor();
        await gateway.waitForRequest("sessions.list", { match: { spawnedBy: mainKey } });
        await gateway.waitForRequest("sessions.list", { match: { spawnedBy: sharedKey } });
        await chooseSidebarOwner(page, "involving-me");
        await gateway.waitForRequest("sessions.list", { match: { involvingMe: true } });
        await sidebar.getByText("My dependency update", { exact: true }).waitFor();
        await toggle.waitFor();
        if ((await toggle.getAttribute("aria-expanded")) !== "true") {
          await toggle.click();
        }
        await row(nestedKey).waitFor();
        await page.mouse.move(1000, 800);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const surface = page.locator("aside.sidebar");
          const frame = await takeControlUiScreenshotFrame(
            page,
            surface,
            [row(sharedKey), row(nestedKey)],
            {
              animations: "disabled",
              elements: [surface],
            },
          );
          await writeFile(path.join(suite.artifactDir, "involving-me.png"), frame.elements[0]!.png);
        }
        expect(await row(unrelatedKey).count()).toBe(0);
        expect(await row(unrelatedNestedKey).count()).toBe(0);
        expect(await row(sharedKey).count()).toBe(1);
        expect(await row(nestedKey).count()).toBe(1);
        expect((await toggle.textContent())?.trim()).toBe("1");
        await chooseSidebarOwner(page, "all");
        await row(unrelatedKey).waitFor();
        await row(unrelatedNestedKey).waitFor();
      },
    );
  });
});
